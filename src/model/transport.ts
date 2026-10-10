import { connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Transport } from './rpc.ts';

export function controlSocketPath(): string {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return join(home, 'app-server-control', 'app-server-control.sock');
}

// The daemon's control socket speaks WebSocket (`codex app-server proxy` only pipes bytes to it),
// so a minimal client over a Unix socket avoids starting any process.
export function connectDaemon(socketPath = controlSocketPath(), timeoutMs = 5000): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const key = randomBytes(16).toString('base64');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to the Codex app-server daemon at ${socketPath}`));
    }, timeoutMs);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      const response = head.subarray(0, end).toString();
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (!/^HTTP\/1\.1 101/.test(response) || !response.toLowerCase().includes(accept.toLowerCase())) {
        socket.destroy();
        reject(new Error(`Codex app-server daemon refused the WebSocket upgrade: ${response.split('\r\n')[0]}`));
        return;
      }
      resolve(new WebSocketTransport(socket, head.subarray(end + 4)));
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(
      `GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });
}

export class WebSocketTransport implements Transport {
  private socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private messageHandler: ((message: string) => void) | undefined;
  private early: string[] = [];
  private closeHandler: (error?: Error) => void = () => {};
  private closed = false;

  constructor(socket: Socket, initial: Buffer) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (error) => this.finish(error));
    socket.on('close', () => this.finish());
    if (initial.length) this.receive(initial);
  }

  send(message: string): void {
    this.write(0x1, Buffer.from(message));
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
    for (const message of this.early.splice(0)) handler(message);
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  ref(): void {
    this.socket.ref();
  }

  unref(): void {
    this.socket.unref();
  }

  close(): void {
    if (this.closed) return;
    this.write(0x8, Buffer.alloc(0));
    this.socket.end();
    this.finish();
  }

  private write(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    const length = payload.length;
    const header =
      length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (length < 126) header[1] = 0x80 | length;
    else if (length < 65536) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const mask = randomBytes(4);
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i++) masked[i] = payload[i]! ^ mask[i & 3]!;
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0]! & 0x80) !== 0;
      const opcode = this.buffer[0]! & 0x0f;
      const masked = (this.buffer[1]! & 0x80) !== 0;
      let length = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]!));
      }
      this.buffer = this.buffer.subarray(offset + length);
      this.frame(fin, opcode, payload);
    }
  }

  private frame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x9) this.write(0xa, payload);
    else if (opcode === 0x8) this.close();
    else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      this.fragments.push(payload);
      if (!fin) return;
      const message = Buffer.concat(this.fragments).toString();
      this.fragments = [];
      if (this.messageHandler) this.messageHandler(message);
      else this.early.push(message);
    }
  }

  private finish(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler(error);
  }
}

// Fallback when no daemon can be reached: a private app-server over stdio, one JSON message per line.
export function spawnAppServer(command = 'codex', home?: string): Transport {
  const child = spawn(command, ['-c', 'features.plugins=false', '-c', 'features.remote_plugin=false', 'app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], env: home ? { ...process.env, CODEX_HOME: home } : process.env });
  let messageHandler: (message: string) => void = () => {};
  let closeHandler: (error?: Error) => void = () => {};
  let closed = false;
  let pending = '';
  let stderr = '';
  const finish = (error?: Error) => {
    if (closed) return;
    closed = true;
    closeHandler(error);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) messageHandler(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.on('error', (error: NodeJS.ErrnoException) =>
    finish(
      new Error(
        error.code === 'ENOENT'
          ? `\`${command}\` is not on PATH; install the Codex CLI and run \`codex login\``
          : `could not start \`${command} app-server\`: ${error.message}`,
      ),
    ),
  );
  child.on('exit', (code, signal) =>
    finish(code || signal ? new Error(`codex app-server exited (${code ?? signal}): ${stderr.trim().slice(-500)}`) : undefined),
  );
  return {
    send: (message) => {
      if (!closed) child.stdin.write(`${message}\n`);
    },
    onMessage: (handler) => {
      messageHandler = handler;
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
    close: () => {
      child.stdin.end();
      child.kill();
      finish();
    },
    ref: () => {
      child.ref();
      for (const stream of [child.stdin, child.stdout, child.stderr] as any[]) stream.ref?.();
    },
    unref: () => {
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr] as any[]) stream.unref?.();
    },
  };
}
