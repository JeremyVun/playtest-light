import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const CHROME_VERSION = '155.0.8059.39';

function platformName(): string {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux64';
  if (platform === 'win32') return arch === 'x64' ? 'win64' : 'win32';
  throw new Error(`No chrome-headless-shell build for ${platform}-${arch}`);
}

export function chromeCacheDir(version = CHROME_VERSION): string {
  return join(homedir(), '.cache', 'playtest-lite', 'chrome', version);
}

function binaryPath(dir: string, platform: string): string {
  const exe = platform.startsWith('win') ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  return join(dir, `chrome-headless-shell-${platform}`, exe);
}

// Resolves the browser executable, downloading the pinned build on first use.
export async function chromeExecutable(): Promise<string> {
  const override = process.env.PLAYTEST_CHROME;
  if (override) return override;
  const platform = platformName();
  const dir = chromeCacheDir();
  const bin = binaryPath(dir, platform);
  if (existsSync(bin)) return bin;

  const meta = await fetch(`https://googlechromelabs.github.io/chrome-for-testing/${CHROME_VERSION}.json`);
  if (!meta.ok) throw new Error(`Chrome for Testing metadata for ${CHROME_VERSION}: HTTP ${meta.status}`);
  const body = (await meta.json()) as { downloads?: Record<string, { platform: string; url: string }[]> };
  const url = body.downloads?.['chrome-headless-shell']?.find((d) => d.platform === platform)?.url;
  if (!url) throw new Error(`No chrome-headless-shell ${CHROME_VERSION} download for ${platform}`);

  process.stderr.write(`Downloading chrome-headless-shell ${CHROME_VERSION} (${platform})...\n`);
  const zip = await fetch(url);
  if (!zip.ok) throw new Error(`Downloading ${url}: HTTP ${zip.status}`);
  await mkdir(join(dir, '..'), { recursive: true });
  const staging = await mkdtemp(join(dir, '..', `.${CHROME_VERSION}-`));
  try {
    const zipPath = join(staging, 'chrome.zip');
    await writeFile(zipPath, Buffer.from(await zip.arrayBuffer()));
    await promisify(execFile)('unzip', ['-q', zipPath, '-d', join(staging, 'out')]);
    if (!existsSync(binaryPath(join(staging, 'out'), platform))) throw new Error(`Unexpected archive layout in ${url}`);
    // Rename is atomic, so a concurrent install either wins or finds the finished directory.
    await rename(join(staging, 'out'), dir).catch((error: NodeJS.ErrnoException) => {
      if (!existsSync(bin)) throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return bin;
}
