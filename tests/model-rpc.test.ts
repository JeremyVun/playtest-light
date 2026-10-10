import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcClient, RpcError, type Transport } from '../src/model/rpc.ts';
import { connectDaemon } from '../src/model/transport.ts';

function fakeTransport() {
  const sent: any[] = [];
  let deliver: (message: string) => void = () => {};
  let closeHandler: (error?: Error) => void = () => {};
  const refs: string[] = [];
  const transport: Transport = {
    send: (message) => sent.push(JSON.parse(message)),
    onMessage: (handler) => {
      deliver = handler;
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
    close: () => closeHandler(),
    ref: () => refs.push('ref'),
    unref: () => refs.push('unref'),
  };
  return { transport, sent, refs, push: (message: object) => deliver(JSON.stringify(message)), drop: (error?: Error) => closeHandler(error) };
}

test('requests carry ids without a jsonrpc field and resolve by id', async () => {
  const fake = fakeTransport();
  const rpc = new RpcClient(fake.transport);
  const a = rpc.request('a', { x: 1 });
  const b = rpc.request('b', {});
  assert.deepEqual(fake.sent, [
    { id: 1, method: 'a', params: { x: 1 } },
    { id: 2, method: 'b', params: {} },
  ]);
  fake.push({ id: 2, result: 'second' });
  fake.push({ id: 1, result: 'first' });
  assert.equal(await a, 'first');
  assert.equal(await b, 'second');
});

test('error responses reject with the method and message', async () => {
  const fake = fakeTransport();
  const rpc = new RpcClient(fake.transport);
  const pending = rpc.request('thread/start', {});
  fake.push({ id: 1, error: { code: -32600, message: 'bad model' } });
  await assert.rejects(pending, (error: RpcError) => error.code === -32600 && error.message === 'thread/start: bad model');
});

test('notifications reach every handler and server requests are answered', async () => {
  const fake = fakeTransport();
  const rpc = new RpcClient(fake.transport);
  const seen: string[] = [];
  rpc.onNotification((method) => seen.push(method));
  rpc.onRequest(async (method, params) => {
    if (method === 'fail') throw new Error('nope');
    return { echo: params };
  });
  fake.push({ method: 'turn/started', params: {} });
  fake.push({ id: 'srv-1', method: 'item/tool/call', params: { a: 1 } });
  fake.push({ id: 7, method: 'fail', params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['turn/started']);
  assert.deepEqual(fake.sent, [
    { id: 'srv-1', result: { echo: { a: 1 } } },
    { id: 7, error: { code: -32603, message: 'nope' } },
  ]);
});

test('a dropped connection rejects pending requests and tells handlers', async () => {
  const fake = fakeTransport();
  const rpc = new RpcClient(fake.transport);
  const seen: string[] = [];
  rpc.onNotification((method, params) => seen.push(`${method}:${params.message}`));
  const pending = rpc.request('turn/start', {});
  fake.drop(new Error('socket hang up'));
  await assert.rejects(pending, /socket hang up/);
  assert.deepEqual(seen, ['transport/closed:socket hang up']);
  await assert.rejects(rpc.request('again', {}), /socket hang up/);
});

test('the connection holds the process only while requests or holds are open', async () => {
  const fake = fakeTransport();
  const rpc = new RpcClient(fake.transport);
  assert.deepEqual(fake.refs, ['unref']);
  const pending = rpc.request('a', {});
  assert.equal(fake.refs.at(-1), 'ref');
  fake.push({ id: 1, result: null });
  await pending;
  assert.equal(fake.refs.at(-1), 'unref');
  const release = rpc.hold();
  assert.equal(fake.refs.at(-1), 'ref');
  release();
  release();
  assert.equal(fake.refs.at(-1), 'unref');
});

function serverFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (length < 126) header[1] = length;
  else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function readClientFrames(buffer: Buffer): { opcode: number; payload: Buffer }[] {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const opcode = buffer[offset]! & 0x0f;
    assert.ok(buffer[offset + 1]! & 0x80, 'client frames must be masked');
    let length = buffer[offset + 1]! & 0x7f;
    let at = offset + 2;
    if (length === 126) {
      length = buffer.readUInt16BE(at);
      at += 2;
    } else if (length === 127) {
      length = Number(buffer.readBigUInt64BE(at));
      at += 8;
    }
    const mask = buffer.subarray(at, at + 4);
    const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length).map((b, i) => b ^ mask[i & 3]!));
    frames.push({ opcode, payload });
    offset = at + 4 + length;
  }
  return frames;
}

test('the daemon transport speaks WebSocket over a Unix socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'playtest-ws-'));
  const path = join(dir, 'control.sock');
  let received: Buffer = Buffer.alloc(0);
  let server!: Socket;
  const listener = createServer();
  const upgraded = new Promise<void>((resolve) => {
    listener.on('connection', (socket) => {
      server = socket;
      let head = '';
      socket.on('data', (chunk: Buffer) => {
        if (!head.includes('\r\n\r\n')) {
          head += chunk.toString();
          if (!head.includes('\r\n\r\n')) return;
          const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(head)![1]!;
          const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
          const hello = serverFrame(0x1, Buffer.from('{"method":"hello"}'));
          const big = Buffer.from(JSON.stringify({ method: 'big', params: { text: 'x'.repeat(70_000) } }));
          socket.write(
            Buffer.concat([
              Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
              hello.subarray(0, 7),
            ]),
          );
          socket.write(hello.subarray(7));
          socket.write(serverFrame(0x9, Buffer.from('p')));
          socket.write(Buffer.concat([serverFrame(0x1, Buffer.from('{"method":'), false), serverFrame(0x0, Buffer.from('"fragmented"}'))]));
          socket.write(serverFrame(0x1, big));
          resolve();
          return;
        }
        received = Buffer.concat([received, chunk]);
      });
    });
  });
  await new Promise<void>((resolve) => listener.listen(path, resolve));
  try {
    const transport = await connectDaemon(path);
    const messages: string[] = [];
    transport.onMessage((message) => messages.push(message));
    await upgraded;
    const long = 'y'.repeat(300);
    transport.send('{"id":1}');
    transport.send(long);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(messages.length, 3);
    assert.deepEqual(messages.slice(0, 2), ['{"method":"hello"}', '{"method":"fragmented"}']);
    assert.equal(JSON.parse(messages[2]!).params.text.length, 70_000);
    const frames = readClientFrames(received);
    assert.deepEqual(
      frames.map((f) => [f.opcode, f.payload.toString()]),
      [
        [0xa, 'p'],
        [0x1, '{"id":1}'],
        [0x1, long],
      ],
    );
    transport.close();
  } finally {
    server?.destroy();
    listener.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing daemon socket fails with ENOENT so the caller can start one', async () => {
  await assert.rejects(connectDaemon(join(tmpdir(), 'playtest-no-such-dir', 'control.sock')), { code: 'ENOENT' });
});
