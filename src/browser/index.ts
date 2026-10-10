export { connectBrowser } from './browser.ts';
export { CHROME_VERSION, chromeExecutable } from './install.ts';
export { isRunning, launchBrowser, stopBrowser, type LaunchedBrowser } from './launch.ts';
export { FINGERPRINT_THRESHOLD, fingerprintDistance, fingerprintsMatch } from './fingerprint.ts';
export { lastActTimings, resizePage, type ActTimings } from './page.ts';
