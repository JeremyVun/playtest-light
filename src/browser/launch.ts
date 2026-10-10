import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserProcess } from '../types.ts';
import { chromeExecutable } from './install.ts';

// userDataDir is extra to the contract so stopBrowser can remove it.
export type LaunchedBrowser = BrowserProcess & { userDataDir: string };

const FLAGS = [
  '--headless',
  '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1',
  '--use-mock-keychain',
  '--password-store=basic',
  '--hide-scrollbars',
  '--disable-frame-rate-limit',
  '--disable-gpu-vsync',
  '--force-device-scale-factor=1',
  '--lang=en-US',
  '--font-render-hinting=none',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-service-autorun',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--metrics-recording-only',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-search-engine-choice-screen',
  '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,AutofillServerCommunication,PaintHolding',
];

export async function launchBrowser(opts: { timeoutMs?: number } = {}): Promise<LaunchedBrowser> {
  const executable = await chromeExecutable();
  const userDataDir = await mkdtemp(join(tmpdir(), 'playtest-lite-chrome-'));
  const args = [...FLAGS, `--user-data-dir=${userDataDir}`];
  if (process.platform === 'linux') args.push('--disable-dev-shm-usage', '--no-sandbox');
  const child = spawn(executable, [...args, 'about:blank'], { detached: true, stdio: 'ignore' });
  child.unref();

  let exited: string | undefined;
  child.once('exit', (code, signal) => (exited = `exited with ${signal ?? code}`));
  child.once('error', (error) => (exited = error.message));

  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  const portFile = join(userDataDir, 'DevToolsActivePort');
  for (let delay = 2; ; delay = Math.min(delay * 2, 25)) {
    const text = await readFile(portFile, 'utf8').catch(() => '');
    const [port, path] = text.split('\n');
    if (port && path) {
      const version = await browserVersion(Number(port));
      return { pid: child.pid!, wsUrl: `ws://127.0.0.1:${port}${path}`, version, userDataDir };
    }
    if (exited || Date.now() > deadline) {
      if (!exited && child.pid) killGroup(child.pid, 'SIGKILL');
      await rm(userDataDir, { recursive: true, force: true });
      throw new Error(`chrome-headless-shell (${executable}) did not start: ${exited ?? 'timed out'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function browserVersion(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const body = (await res.json()) as { Browser: string };
  return body.Browser.replace(/^.*\//, '');
}

function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function stopBrowser(proc: { pid: number; userDataDir?: string }): Promise<void> {
  if (killGroup(proc.pid, 'SIGTERM')) {
    const deadline = Date.now() + 3000;
    while (isRunning(proc.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    if (isRunning(proc.pid)) killGroup(proc.pid, 'SIGKILL');
  }
  if (proc.userDataDir) await rm(proc.userDataDir, { recursive: true, force: true });
}
