// The canvas disk watcher keeps ONE watcher PER AGENT, so stopping one agent's
// watch must remove exactly that agent's listener. `fs.unwatchFile(path)` with no
// listener argument removes EVERY listener registered for that path — so when two
// agents show the same file (a shared project document), stopping one of them
// would silently drop the other's listener and leave its map entry stale (the
// later start returns early and the shared file is never watched again). These
// tests pin that stop passes the exact per-agent listener through.

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs', () => {
  const watchFile = vi.fn();
  const unwatchFile = vi.fn();
  return { default: { watchFile, unwatchFile }, watchFile, unwatchFile };
});

vi.mock('../../gateway/ws.js', () => ({
  broadcast: vi.fn(),
}));

import { broadcast } from '../../gateway/ws.js';
import { startCanvasWatch, stopCanvasWatch } from '../canvas-watch.js';

afterEach(() => {
  stopCanvasWatch('A');
  stopCanvasWatch('B');
  vi.clearAllMocks();
});

describe('canvas watch is per-agent', () => {
  it('stops A with A own listener, never B and never a bare path', () => {
    startCanvasWatch('A', '/work/plan.md');
    startCanvasWatch('B', '/work/plan.md');
    const listenerA = vi.mocked(fs.watchFile).mock.calls[0][2];
    const listenerB = vi.mocked(fs.watchFile).mock.calls[1][2];
    stopCanvasWatch('A');
    const calls = vi.mocked(fs.unwatchFile).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[0]).toBe('/work/plan.md');
      expect(call[1]).toBeDefined();
      expect(call[1]).toBe(listenerA);
      expect(call[1]).not.toBe(listenerB);
    }
  });

  it('stops B later with B own listener', () => {
    startCanvasWatch('A', '/work/plan.md');
    startCanvasWatch('B', '/work/plan.md');
    const listenerB = vi.mocked(fs.watchFile).mock.calls[1][2];
    stopCanvasWatch('B');
    const call = vi.mocked(fs.unwatchFile).mock.calls[0];
    expect(call[0]).toBe('/work/plan.md');
    expect(call[1]).toBe(listenerB);
  });

  it('starting the same agent on the same path twice watches once', () => {
    startCanvasWatch('A', '/work/plan.md');
    startCanvasWatch('A', '/work/plan.md');
    expect(vi.mocked(fs.watchFile)).toHaveBeenCalledTimes(1);
  });

  it('switching path unwatches the old listener then watches the new path', () => {
    startCanvasWatch('A', '/a.md');
    const listenerA = vi.mocked(fs.watchFile).mock.calls[0][2];
    startCanvasWatch('A', '/b.md');
    const unwatchCall = vi.mocked(fs.unwatchFile).mock.calls[0];
    expect(unwatchCall[0]).toBe('/a.md');
    expect(unwatchCall[1]).toBe(listenerA);
    expect(vi.mocked(fs.watchFile)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fs.watchFile).mock.calls[1][0]).toBe('/b.md');
  });

  it('stopping an unknown agent makes no unwatch call', () => {
    stopCanvasWatch('nobody');
    expect(vi.mocked(fs.unwatchFile)).not.toHaveBeenCalled();
  });

  it('broadcasts canvas:updated only when the mtime changed', () => {
    startCanvasWatch('A', '/work/plan.md');
    const listener = vi.mocked(fs.watchFile).mock.calls[0][2];
    listener({ mtimeMs: 2 }, { mtimeMs: 1 });
    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith({
      type: 'canvas:updated', agentId: 'A', data: { path: '/work/plan.md' },
    });
    vi.mocked(broadcast).mockClear();
    listener({ mtimeMs: 2 }, { mtimeMs: 2 });
    expect(vi.mocked(broadcast)).not.toHaveBeenCalled();
  });
});
