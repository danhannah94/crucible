import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureStorageState } from '../../src/adapters/login.mjs';

const fakeBrowserBuilder = ({ closeBehavior = 'normal' } = {}) => {
  const events = { browserClose: false, listeners: { context: [], browser: [] } };
  const ctx = {
    newPage: async () => ({
      mainFrame: () => ({}),
      on: () => {},
      goto: async () => {},
    }),
    storageState: async () => ({ cookies: [{ name: 'sid', value: 'abc' }], origins: [] }),
    on: (ev, fn) => events.listeners.context.push({ ev, fn }),
  };
  const browser = {
    newContext: async () => ctx,
    close: async () => {
      events.browserClose = true;
      if (closeBehavior === 'hang') {
        return new Promise(() => {});
      }
      if (closeBehavior === 'throw') {
        throw new Error('Target closed');
      }
    },
    on: (ev, fn) => events.listeners.browser.push({ ev, fn }),
  };
  return { browser, events };
};

const launcherFor = (browser) => ({ launch: async () => browser });

const adapterFor = async (suffix) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `crucible-sigint-${suffix}-`));
  return {
    name: 'fake',
    url: 'https://example.com',
    authStrategy: 'cookie-handoff',
    storageStatePath: path.join(root, 'fake.json'),
  };
};

const fireSigintAfter = async (ms = 0) => {
  await new Promise((r) => setImmediate(r));
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  process.emit('SIGINT');
};

describe('captureStorageState — SIGINT capture race', () => {
  it('writes the state file even when browser.close hangs', async () => {
    const { browser, events } = fakeBrowserBuilder({ closeBehavior: 'hang' });
    const adapter = await adapterFor('hang');

    const promise = captureStorageState({
      adapter,
      isWSL: async () => false,
      launcher: launcherFor(browser),
      log: vi.fn(),
    });
    fireSigintAfter();

    const savedPath = await promise;
    expect(savedPath).toBe(adapter.storageStatePath);
    await access(adapter.storageStatePath);
    const written = JSON.parse(await readFile(adapter.storageStatePath, 'utf8'));
    expect(written.cookies[0].name).toBe('sid');
    expect(events.browserClose).toBe(true);
  });

  it('still writes even when browser.close throws', async () => {
    const { browser } = fakeBrowserBuilder({ closeBehavior: 'throw' });
    const adapter = await adapterFor('throw');

    const promise = captureStorageState({
      adapter,
      isWSL: async () => false,
      launcher: launcherFor(browser),
      log: vi.fn(),
    });
    fireSigintAfter();

    const savedPath = await promise;
    await access(savedPath);
  });

  it('removes its SIGINT listener before returning (no leaks across calls)', async () => {
    const before = process.listenerCount('SIGINT');
    const { browser } = fakeBrowserBuilder();
    const adapter = await adapterFor('cleanup');

    const promise = captureStorageState({
      adapter,
      isWSL: async () => false,
      launcher: launcherFor(browser),
      log: vi.fn(),
    });
    fireSigintAfter();
    await promise;

    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('uses process.on (not once) so handler is durable across residual signals', async () => {
    const before = process.listenerCount('SIGINT');
    const { browser } = fakeBrowserBuilder();
    const adapter = await adapterFor('durable');

    const promise = captureStorageState({
      adapter,
      isWSL: async () => false,
      launcher: launcherFor(browser),
      log: vi.fn(),
    });

    await new Promise((r) => setImmediate(r));
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    process.emit('SIGINT');
    await promise;
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
