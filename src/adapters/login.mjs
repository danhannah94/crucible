import { promises as fs } from 'node:fs';
import { chromium } from 'playwright';
import { writeStorageState } from './storage-state.mjs';

/**
 * Headed Chromium under WSL2 + WSLg can freeze the host or trigger D3D
 * driver crashes when its compositor process tries to use GPU acceleration
 * through the WSLg shim. Disable GPU paths so the browser renders entirely
 * on the CPU. Negligible perf cost during a one-shot interactive login;
 * massive stability win.
 *
 * Detection reads `/proc/version` for "microsoft" / "WSL" tokens. Falsy
 * (file missing, error, no match) means we're not on WSL and apply nothing.
 */
export async function detectWSL() {
  try {
    const v = await fs.readFile('/proc/version', 'utf8');
    return /microsoft|wsl/i.test(v);
  } catch {
    return false;
  }
}

export const WSL_LAUNCH_ARGS = Object.freeze([
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-dev-shm-usage',
  '--no-sandbox',
]);

/**
 * Strip Playwright's automation tells for interactive logins. navigator.webdriver
 * (set via the AutomationControlled blink feature) and the --enable-automation
 * switch are how identity providers — Google especially — detect a non-human
 * browser and refuse to authenticate ("This browser or app may not be secure").
 * A human is driving this login, so removing them is correct, not a hack.
 */
export const AUTOMATION_EVASION_ARGS = Object.freeze([
  '--disable-blink-features=AutomationControlled',
]);

/**
 * Open a non-headless browser at the adapter's URL and wait for the user to
 * complete login interactively (typically SSO + 2FA). Captures the resulting
 * `storageState` (cookies + localStorage) to disk.
 *
 * Termination signal: SIGINT (Ctrl+C in the launching terminal). The browser
 * stays alive until the signal arrives so `context.storageState()` can be
 * read while the page is still open. The browser-close event is a fallback
 * for users who close the window directly — state is captured on every
 * main-frame navigation so the most recent snapshot is always available.
 *
 * Note: this hooks process-level SIGINT by default. Long-lived host processes
 * that don't want their own SIGINT handler displaced should pass
 * `installSignalHandler: false` and resolve a signal of their own choosing.
 *
 * Returns the path the state was written to.
 */
export async function captureStorageState({
  adapter,
  log = (msg) => console.error(`[crucible login] ${msg}`),
  installSignalHandler = true,
  isWSL = detectWSL,
  launcher = chromium,
} = {}) {
  if (!adapter) throw new Error('adapter is required');
  if (!adapter.url) throw new Error('adapter.url is required');
  if (!adapter.storageStatePath) throw new Error('adapter.storageStatePath is required (cookie-handoff strategy?)');

  log(`launching non-headless chromium at ${adapter.url}`);
  log(`complete login in the browser, then press Ctrl+C in this terminal to save.`);

  // Interactive SSO frequently runs through identity providers (notably Google)
  // that refuse to authenticate in an automation-controlled browser — the
  // "This browser or app may not be secure" wall. Two things trip that detector:
  // Playwright's bundled Chromium (not real Chrome), and the automation tells it
  // sets by default — navigator.webdriver (the AutomationControlled blink
  // feature) and the --enable-automation switch. A human-driven login gains
  // nothing from those, so strip them and prefer the real Chrome channel,
  // falling back to bundled Chromium when Chrome isn't installed.
  const launchOpts = {
    headless: false,
    args: [...AUTOMATION_EVASION_ARGS],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (await isWSL()) {
    log('detected WSL — disabling GPU paths to avoid WSLg compositor crashes');
    launchOpts.args.push(...WSL_LAUNCH_ARGS);
  }

  let browser;
  try {
    browser = await launcher.launch({ ...launchOpts, channel: 'chrome' });
    log('launched real Google Chrome (channel=chrome) — best odds past IdP automation blocks');
  } catch (err) {
    log(
      `real Chrome unavailable (${(err.message || '').split('\n')[0]}); falling back to bundled Chromium`,
    );
    browser = await launcher.launch(launchOpts);
  }
  const context = await browser.newContext();
  const page = await context.newPage();

  let lastSnapshot = null;
  const snapshotState = async () => {
    try {
      lastSnapshot = await context.storageState();
    } catch {
      // Context closed mid-snapshot — keep the previous good value.
    }
  };

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) snapshotState();
  });

  try {
    await page.goto(adapter.url, { waitUntil: 'load', timeout: 60_000 });
  } catch (err) {
    log(`initial navigation failed (${err.message}) — proceeding anyway; you can navigate manually.`);
  }

  await snapshotState();

  let sigintListener = null;
  await new Promise((resolve) => {
    let resolved = false;
    const finish = (reason) => {
      if (!resolved) {
        resolved = true;
        log(`captured (${reason}) — saving state.`);
        resolve();
      }
    };
    if (installSignalHandler) {
      sigintListener = () => finish('SIGINT');
      // `on`, not `once`: a permanent listener keeps Node from taking the
      // default-exit path on residual SIGINTs between the awaits below.
      // Removed explicitly before return.
      process.on('SIGINT', sigintListener);
    }
    context.on('close', () => finish('context-closed'));
    browser.on('disconnected', () => finish('browser-disconnected'));
  });

  // One last snapshot. After SIGINT, Chromium received the signal too and may
  // already be tearing down; snapshotState() is wrapped in try/catch and
  // keeps `lastSnapshot` from the most recent main-frame navigation if this
  // read fails.
  await snapshotState();

  if (!lastSnapshot) {
    if (sigintListener) process.off('SIGINT', sigintListener);
    throw new Error('failed to capture storageState — no successful snapshot taken. Try again.');
  }

  // Write before closing the browser. browser.close() can hang indefinitely
  // after SIGINT because the CDP connection died with Chromium. The state
  // file is the load-bearing artifact; don't let cleanup block it.
  await writeStorageState(adapter.storageStatePath, lastSnapshot);
  log(`wrote storageState to ${adapter.storageStatePath}`);

  // Best-effort teardown with a short timeout.
  try {
    await Promise.race([
      browser.close(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch {}

  if (sigintListener) process.off('SIGINT', sigintListener);
  return adapter.storageStatePath;
}
