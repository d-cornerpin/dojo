// ════════════════════════════════════════════════════════════════════════════
// THE UNPACK RUNS `unzip` QUIET — ITS PER-FILE LINES CAN FILL THE OUTPUT BUFFER.
//
// `downloadAndInstall` unpacks the release through the promisified `exec`, which keeps
// everything the command prints in a buffer of about 1 MiB. `unzip -o` prints one line per
// file, and a release is a whole platform tree: the installer test found a long install path
// pushing that output past the buffer, and the update died with "stdout maxBuffer length
// exceeded" while the unpack itself had gone fine. From a real home path the margin is about
// 2x, and every release adds files. The fix is in HOW the command is invoked, not in how big
// the buffer is: with `-q` unzip prints nothing per file.
//
// The clause drives the product's own door — the real `applyUpdate` — with no real command
// running: `exec` records its command and reports success, `spawn` hands back a child that
// already closed cleanly (so the real idle bound watches a finished process), and the release
// listing is a stubbed fetch. What it pins is the argument list the unpack was attempted with:
// `-q` (quiet, the fix) beside `-o` (overwrite, the behaviour that must survive).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { makeTree } from './t197-safe-install-fixtures.js';

const home = process.env.DOJO_HOME as string;
const dojo = path.join(home, '.dojo');
const platform = path.join(dojo, 'platform');

/** Every `exec` command the code under test tried to run. */
const { execCmds } = vi.hoisted(() => ({ execCmds: [] as string[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  // Records the command string, then calls back success — that callback is what the
  // promisified helper awaits, so nothing real is spawned or shell-executed.
  const exec = (...a: unknown[]): void => {
    execCmds.push(String(a[0]));
    const cb = a[a.length - 1] as (err: null, ...out: string[]) => void;
    queueMicrotask(() => cb(null, '', ''));
  };
  const spawn = () => {
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: () => true, pid: 4242 });
    process.nextTick(() => child.emit('close', 0, null));
    return child;
  };
  return { ...orig, default: { ...orig, exec, spawn }, exec, spawn };
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

describe('the-update-unzip-prints-nothing', () => {
  it('the release is unpacked with `unzip -q -o`: no per-file line to overflow the exec buffer', async () => {
    const { applyUpdate } = await import('../../gateway/routes/update.js');
    await applyUpdate('stable');
    const unpack = execCmds.find(c => c.includes('unzip'));
    expect(unpack, 'the update unpacks the release with `unzip` through exec').toBeDefined();
    // The flags between the program name and the zip path; the paths stay quoted untouched.
    const head = unpack!.slice(0, unpack!.indexOf('"')).trim().split(/\s+/);
    expect(head[0]).toBe('unzip');
    expect(head.slice(1)).toContain('-q');
    expect(head.slice(1)).toContain('-o');
  }, 60_000);
});
