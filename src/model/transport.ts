import { spawn } from 'node:child_process';
import type { Transport } from './rpc.ts';

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
  child.stdin.on('error', (error) => finish(new Error(`Codex app-server input closed: ${error.message}`)));
  child.on('close', (code, signal) =>
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
