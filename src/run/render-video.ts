import { spawn } from 'node:child_process';
import { accessSync, constants, openSync, readSync, closeSync, writeFileSync, rmSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export const FRAME_SECONDS = 1.2;
const LAST_FRAME_SECONDS = 2.5;

export function findFfmpeg(path = process.env.PATH ?? ''): string | undefined {
  const candidates = [process.env.PLAYTEST_FFMPEG, ...path.split(delimiter).filter(Boolean).map((d) => join(d, 'ffmpeg'))];
  for (const c of candidates) {
    if (!c) continue;
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {}
  }
  return undefined;
}

export function pngSize(file: string): [number, number] {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(24);
    readSync(fd, head, 0, 24, 0);
    return [head.readUInt32BE(16), head.readUInt32BE(20)];
  } finally {
    closeSync(fd);
  }
}

const even = (n: number) => n + (n % 2);

// Stills of different heights are padded onto one white canvas, top-left, so nothing is scaled.
export async function makeVideo(ffmpeg: string, frames: string[], out: string): Promise<void> {
  const sizes = frames.map(pngSize);
  const width = even(Math.max(...sizes.map((s) => s[0])));
  const height = even(Math.max(...sizes.map((s) => s[1])));
  const list = join(dirname(out), '.frames.txt');
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => lines.push(`file '${f.replaceAll("'", "'\\''")}'`, `duration ${i === frames.length - 1 ? LAST_FRAME_SECONDS : FRAME_SECONDS}`));
  // The concat demuxer ignores the last entry's duration unless the file is listed again.
  lines.push(`file '${frames[frames.length - 1].replaceAll("'", "'\\''")}'`);
  writeFileSync(list, `${lines.join('\n')}\n`);
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list];
    args.push('-vf', `pad=${width}:${height}:0:0:color=white,format=yuv420p`, '-r', '5', '-movflags', '+faststart', out);
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise<number>((resolve) => {
      child.on('error', () => resolve(127));
      child.on('exit', (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`);
  } finally {
    rmSync(list, { force: true });
  }
}
