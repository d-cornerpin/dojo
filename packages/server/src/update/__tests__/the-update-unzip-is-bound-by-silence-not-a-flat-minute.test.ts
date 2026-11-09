// ════════════════════════════════════════════════════════════════════════════
// THE UNPACK IS BOUND BY SILENCE, NOT BY A FLAT MINUTE (R25, R27; C13 / P13).
//
// `unzip` of a full release tree used to run under a flat 60 s total and `-q`, so a slow or busy
// Mac that needed longer failed EVERY update attempt. It now runs through the one idle-bound
// spawner the download and the install already use: `unzip -o` prints a line per file, each line
// re-arms the bound, and output is STREAMED (never held in a 1 MiB buffer), so the overflow that
// `-q` was added for cannot return. The native-module smoke check of the staged tree had the same
// flat 60 s; it now has no flat total either.
//
// The clause drives the real `applyUpdate` with no real command running and pins what the unpack
// was attempted with: spawned (not buffered `execFile`), no `-q`, `-o` kept.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { makeTree } from './safe-install-fixtures.js';

const home = process.env.DOJO_HOME as string;
const dojo = path.join(home, '.dojo');
const platform = path.join(dojo, 'platform');

/** Every `exec` command the code under test tried to run. */
const { execCmds, spawnCmds } = vi.hoisted(() => ({ execCmds: [] as string[][], spawnCmds: [] as string[][] }));

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  // Records the command string, then calls back success — that callback is what the
  // promisified helper awaits, so nothing real is spawned or shell-executed.
  const exec = (...a: unknown[]): void => {
    execCmds.push([String(a[0]), ...(Array.isArray(a[1]) ? (a[1] as string[]) : [])]);
    const cb = a[a.length - 1] as (err: null, ...out: string[]) => void;
    queueMicrotask(() => cb(null, '', ''));
  };
  const spawn = (file: string, argv: string[] = []) => {
    spawnCmds.push([file, ...argv]);
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: () => true, pid: 4242 });
    process.nextTick(() => child.emit('close', 0, null));
    return child;
  };
  return { ...orig, default: { ...orig, execFile: exec, spawn }, execFile: exec, spawn };
});

function cleanDojo(): void {
  for (const n of fs.existsSync(dojo) ? fs.readdirSync(dojo) : []) {
    if (n === 'platform' || n.startsWith('platform.') || n.startsWith('update-state') || n === 'rollback.lock') {
      fs.rmSync(path.join(dojo, n), { recursive: true, force: true });
    }
  }
}

beforeEach(() => {
  cleanDojo();
  execCmds.length = 0;
  spawnCmds.length = 0;
  makeTree(platform, '3.3.3', { native: true });
  fs.mkdirSync(path.join(dojo, 'data'), { recursive: true }); // the volume the pre-flight measures
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    tag_name: 'v3.4.0', name: 'v3.4.0', published_at: '2026-10-17T00:00:00Z', body: '',
    assets: [{ name: 'dojo-platform.zip', browser_download_url: 'https://example.invalid/dojo-platform.zip', size: 1000 }],
  }), { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanDojo();
});

describe('the update unpack is bound by silence', () => {
  it('unzip runs through the idle-bound spawner, loud (no -q), overwrite kept, never as a buffered execFile', async () => {
    const { applyUpdate } = await import('../../gateway/routes/update.js');
    await applyUpdate('stable');
    const unpack = spawnCmds.find(c => c[0] === 'unzip');
    expect(unpack, 'the update unpacks the release with `unzip` through the idle-bound spawner').toBeDefined();
    expect(unpack!.slice(1)).not.toContain('-q');
    expect(unpack!.slice(1)).toContain('-o');
    expect(unpack!.every(a => !a.includes('"'))).toBe(true);
    expect(execCmds.find(c => c[0] === 'unzip'), 'not the buffered, flat-timeout door').toBeUndefined();
  }, 60_000);
});
