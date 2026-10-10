import { spawn } from 'node:child_process';
import type { Project } from '../types.ts';

export async function runSeed(project: Project, timeoutMs = 60_000): Promise<void> {
  const command = project.config.seed;
  if (!command) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, { cwd: project.seedCwd, shell: true, detached: true,
      env: { ...process.env, PLAYTEST_URL: project.config.url }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8192); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const kill = () => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    process.once('SIGINT', kill);
    process.once('SIGTERM', kill);
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', kill);
      process.removeListener('SIGTERM', kill);
    };
    child.once('error', (error) => { cleanup(); reject(new Error(`seed failed: ${error.message}`)); });
    child.once('close', (code, signal) => {
      cleanup();
      if (timedOut || code !== 0) reject(new Error(`seed ${timedOut ? 'timed out' : `failed (${signal ?? `exit ${code}`})`}${output.trim() ? `:\n${output.trim()}` : ''}`));
      else resolve();
    });
  });
}
