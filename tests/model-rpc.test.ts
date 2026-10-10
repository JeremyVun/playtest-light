import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnAppServer } from '../src/model/transport.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient, RpcError, type Transport } from '../src/model/rpc.ts';

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

test('stdio transport joins fragmented replies and reports process failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-stdio-'));
  const executable = join(dir, 'server');
  writeFileSync(executable, String.raw`#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'fail') {
    process.stderr.write('fixture failure', () => process.exit(7));
    return;
  }
  const reply = JSON.stringify({ id: message.id, result: { text: '北極光' } }) + '\n';
  process.stdout.write(reply.slice(0, 8));
  setTimeout(() => process.stdout.write(reply.slice(8)), 10);
});
`, { mode: 0o755 });
  const rpc = new RpcClient(spawnAppServer(executable));
  try {
    assert.deepEqual(await rpc.request('ping', {}), { text: '北極光' });
    await assert.rejects(rpc.request('fail', {}), /exited \(7\): fixture failure/);
  } finally { rpc.close(); rmSync(dir, { recursive: true, force: true }); }
});
