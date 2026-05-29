import { describe, it, expect, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureStorageState, WSL_LAUNCH_ARGS, AUTOMATION_EVASION_ARGS } from '../../src/adapters/login.mjs';

const fakeBrowser = () => {
  const handlers = { context: [], browser: [] };
  const ctx = {
    newPage: async () => ({
      mainFrame: () => ({}),
      on: () => {},
      goto: async () => {},
    }),
    storageState: async () => ({ cookies: [{ name: 'sid', value: 'x' }], origins: [] }),
    on: (ev, fn) => handlers.context.push({ ev, fn }),
  };
  return {
    handlers,
    browser: {
      newContext: async () => ctx,
      close: async () => {},
      on: (ev, fn) => handlers.browser.push({ ev, fn }),
    },
    triggerSigint: () => {
      // simulate SIGINT — runs the handler installed via process.once('SIGINT', ...)
      const sigintListeners = process.listeners('SIGINT');
      sigintListeners[sigintListeners.length - 1]();
    },
  };
};

const fakeLauncher = (calls) => ({
  launch: async (opts) => {
    calls.push(opts);
    const fb = fakeBrowser();
    fb.calls = calls;
    return fb.browser;
  },
});

const adapterFor = async (name) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'crucible-wsl-'));
  return {
    name,
    url: 'https://example.com',
    authStrategy: 'cookie-handoff',
    storageStatePath: path.join(root, `${name}.json`),
  };
};

const runWithSigint = async (promise) => {
  // Give the SIGINT handler a tick to register, then fire it.
  await new Promise((r) => setImmediate(r));
  process.emit('SIGINT');
  return promise;
};

describe('captureStorageState — login launch flags', () => {
  it('strips automation tells and prefers the real Chrome channel (non-WSL)', async () => {
    const calls = [];
    const launcher = fakeLauncher(calls);
    const adapter = await adapterFor('mac-target');
    const log = vi.fn();
    const promise = captureStorageState({
      adapter,
      isWSL: async () => false,
      launcher,
      log,
    });
    await runWithSigint(promise);

    expect(calls).toHaveLength(1);
    expect(calls[0].headless).toBe(false);
    expect(calls[0].channel).toBe('chrome');
    expect(calls[0].args).toEqual([...AUTOMATION_EVASION_ARGS]);
    expect(calls[0].ignoreDefaultArgs).toContain('--enable-automation');
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/detected WSL/);
  });

  it('layers --disable-gpu et al on top of the evasion args when isWSL() is true', async () => {
    const calls = [];
    const launcher = fakeLauncher(calls);
    const adapter = await adapterFor('wsl-target');
    const log = vi.fn();
    const promise = captureStorageState({
      adapter,
      isWSL: async () => true,
      launcher,
      log,
    });
    await runWithSigint(promise);

    expect(calls).toHaveLength(1);
    expect(calls[0].headless).toBe(false);
    expect(calls[0].channel).toBe('chrome');
    expect(calls[0].args).toEqual([...AUTOMATION_EVASION_ARGS, ...WSL_LAUNCH_ARGS]);
    expect(log.mock.calls.flat().join('\n')).toMatch(/detected WSL/);
  });

  it('falls back to bundled Chromium when the chrome channel is unavailable', async () => {
    const calls = [];
    // First launch (channel=chrome) throws as if Chrome isn't installed; the
    // retry without a channel must succeed on bundled Chromium.
    const launcher = {
      launch: async (opts) => {
        calls.push(opts);
        if (opts.channel === 'chrome') {
          throw new Error("Chromium distribution 'chrome' is not found");
        }
        return fakeBrowser().browser;
      },
    };
    const adapter = await adapterFor('no-chrome-target');
    const log = vi.fn();
    const promise = captureStorageState({
      adapter,
      isWSL: async () => false,
      launcher,
      log,
    });
    await runWithSigint(promise);

    expect(calls).toHaveLength(2);
    expect(calls[0].channel).toBe('chrome');
    expect(calls[1].channel).toBeUndefined();
    expect(calls[1].args).toEqual([...AUTOMATION_EVASION_ARGS]);
    expect(log.mock.calls.flat().join('\n')).toMatch(/falling back to bundled Chromium/);
  });

  it('exposes frozen launch-arg lists (no accidental mutation)', () => {
    expect(Object.isFrozen(WSL_LAUNCH_ARGS)).toBe(true);
    expect(WSL_LAUNCH_ARGS).toContain('--disable-gpu');
    expect(WSL_LAUNCH_ARGS).toContain('--disable-software-rasterizer');
    expect(WSL_LAUNCH_ARGS).toContain('--disable-dev-shm-usage');
    expect(WSL_LAUNCH_ARGS).toContain('--no-sandbox');
    expect(Object.isFrozen(AUTOMATION_EVASION_ARGS)).toBe(true);
    expect(AUTOMATION_EVASION_ARGS).toContain('--disable-blink-features=AutomationControlled');
  });
});
