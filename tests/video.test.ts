import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findFfmpeg } from '../src/run/render-video.ts';

test('ffmpeg is found on PATH, and its absence is not an error', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'playtest-ffmpeg-')));
  try {
    const saved = process.env.PLAYTEST_FFMPEG;
    delete process.env.PLAYTEST_FFMPEG;
    assert.equal(findFfmpeg(dir), undefined);
    writeFileSync(join(dir, 'ffmpeg'), '#!/bin/sh\n');
    chmodSync(join(dir, 'ffmpeg'), 0o755);
    assert.equal(findFfmpeg(`/nowhere:${dir}`), join(dir, 'ffmpeg'));
    if (saved !== undefined) process.env.PLAYTEST_FFMPEG = saved;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
