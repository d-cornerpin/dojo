// ════════════════════════════════════════════════════════════════════════════════════════
// t219 — A FULL DISK DURING AN UPDATE SAYS SO, IN WORDS (t217 leg 6).
//
// The child-process runner (`child-idle-bound.ts`) rejects with a plain object
// `{ stdout, stderr, code }`, not an Error. Every reader in the update path assumed an Error,
// so a disk-full download read "The update failed before anything was installed ([object
// Object])" and a disk-full `npm install` carried "[object Object]" in its detail.
//
// These clauses go through the product's own doors: the real `applyUpdate` with a stand-in
// `curl` (the only edge a unit run cannot own), and the real `installPlatformTree`.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTree } from './t197-safe-install-fixtures.js';

const home = process.env.DOJO_HOME as string;
const dojo = path.join(home, '.dojo');
const platform = path.join(dojo, 'platform');
const work = path.join(home, 't219-apply');
const savedPath = process.env.PATH;
const SRC = path.join(__dirname, '..', '..');

function cleanDojo(): void {
  for (const n of fs.existsSync(dojo) ? fs.readdirSync(dojo) : []) {
    if (n === 'platform' || n.startsWith('platform.') || n.startsWith('update-state') || n === 'rollback.lock') {
      fs.rmSync(path.join(dojo, n), { recursive: true, force: true });
    }
  }
}

/** A `curl` that fails the way the test says: prints `stderr`, exits `code`. */
function standInCurl(code: number, stderr: string): void {
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'curl'),
    `#!/bin/sh\ntouch "${path.join(work, 'curl-ran')}"\necho "${stderr}" >&2\nexit ${code}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${savedPath ?? ''}`;
}

/** Report the volume as having `freeAfterCurl` once the stand-in curl has run, plenty before. */
function stubVolume(freeAfterCurl: number): void {
  const real = fs.statfsSync.bind(fs);
  vi.spyOn(fs, 'statfsSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
    const st = real(p, o as never) as fs.StatsFs;
    const free = fs.existsSync(path.join(work, 'curl-ran')) ? freeAfterCurl : 500e9;
    return { ...st, bsize: 1, bavail: free, bfree: free } as fs.StatsFs;
  }) as typeof fs.statfsSync);
}

beforeEach(() => {
  cleanDojo();
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  makeTree(platform, '3.3.3', { native: true });
  fs.mkdirSync(path.join(dojo, 'data'), { recursive: true }); // the volume the pre-flight measures
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    tag_name: 'v3.4.0', name: 'v3.4.0', published_at: '2026-10-17T00:00:00Z', body: '',
    assets: [{ name: 'dojo-platform.zip', browser_download_url: 'https://example.invalid/dojo-platform.zip', size: 1000 }],
  }), { status: 200 })));
});

afterEach(() => {
  process.env.PATH = savedPath;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanDojo();
  fs.rmSync(work, { recursive: true, force: true });
});

describe('a download that fails is described in words, never as an object', () => {
  it('a full disk named in the child\'s own words is the out-of-space sentence', async () => {
    standInCurl(1, 'curl: (23) Failure writing output: No space left on device');
    const { applyUpdate } = await import('../../gateway/routes/update.js');
    const r = await applyUpdate('stable');
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain('[object Object]');
    expect(r.message).toMatch(/ran out of disk space/i);
    expect(r.message).toMatch(/No space left on device/);
    expect(r.status).toBe(507);
  }, 60_000);

  it('curl exit 23 on a volume measured full is the out-of-space sentence', async () => {
    standInCurl(23, 'curl: (23) Failure writing output to destination, passed 16384 returned 337');
    stubVolume(100);
    const { applyUpdate } = await import('../../gateway/routes/update.js');
    const r = await applyUpdate('stable');
    expect(r.message).not.toContain('[object Object]');
    expect(r.message).toMatch(/ran out of disk space/i);
    expect(r.message).toMatch(/Failure writing output to destination/);
    expect(r.message).toMatch(/Nothing was changed/);
    expect(r.status).toBe(507);
  }, 60_000);

  it('the same exit 23 on a volume with room is the generic sentence carrying curl\'s own words', async () => {
    standInCurl(23, 'curl: (23) Failure writing output to destination, passed 16384 returned 337');
    stubVolume(500e9);
    const { applyUpdate } = await import('../../gateway/routes/update.js');
    const r = await applyUpdate('stable');
    expect(r.message).not.toContain('[object Object]');
    expect(r.message).not.toMatch(/ran out of disk space/i);
    expect(r.message).toMatch(/failed before anything was installed/);
    expect(r.message).toMatch(/Failure writing output to destination/);
    expect(r.message).toMatch(/Nothing was changed/);
  }, 60_000);

  it('NEGATIVE CONTROL: a 404 is never relabelled a disk problem, even on a full volume', async () => {
    standInCurl(22, 'curl: (22) The requested URL returned error: 404');
    stubVolume(100);
    const { applyUpdate } = await import('../../gateway/routes/update.js');
    const r = await applyUpdate('stable');
    expect(r.message).not.toContain('[object Object]');
    expect(r.message).not.toMatch(/ran out of disk space/i);
    expect(r.message).toMatch(/404/);
  }, 60_000);

  it('a child that dies with no words at all is still told as a fact (exit code / signal)', async () => {
    const { childFailureText } = await import('../child-failure.js');
    expect(childFailureText({ stdout: '', stderr: '', code: 7 })).toBe('exited with code 7');
    expect(childFailureText({ stdout: '', stderr: '', signal: 'SIGKILL' })).toBe('stopped by SIGKILL');
  });
});

describe('one reader turns any child failure into its text', () => {
  it('Error, plain failure object and string all read as words', async () => {
    const { childFailureText } = await import('../child-failure.js');
    expect(childFailureText(new Error('boom'))).toBe('boom');
    expect(childFailureText('plain words')).toBe('plain words');
    expect(childFailureText({ stdout: '', stderr: 'line one\nline two\n', code: 1 })).toContain('line two');
    expect(childFailureText({ stdout: '', stderr: 'x', code: 1, message: 'no output for 60s' })).toBe('no output for 60s');
    for (const v of [{ stdout: '', stderr: '' }, {}, null, undefined, 42]) {
      expect(childFailureText(v)).not.toContain('[object Object]');
    }
  });

  it('isOutOfSpaceError reads a failure object\'s stderr and stdout', async () => {
    const { isOutOfSpaceError } = await import('../disk-preflight.js');
    expect(isOutOfSpaceError({ stdout: '', stderr: 'npm error code ENOSPC', code: 1 })).toBe(true);
    expect(isOutOfSpaceError({ stdout: 'No space left on device', stderr: '', code: 1 })).toBe(true);
    expect(isOutOfSpaceError({ stdout: '', stderr: 'curl: (22) 404', code: 22 })).toBe(false);
    expect(isOutOfSpaceError({ stdout: '', stderr: '', code: 23 })).toBe(false);
  });
});

describe('npm running out of space through installPlatformTree', () => {
  it('names the disk and carries no [object Object] in the detail', async () => {
    const { installPlatformTree } = await import('../install-tree.js');
    const staged = makeTree(path.join(work, 'staged'), '3.4.0');
    const r = await installPlatformTree({
      dojoDir: dojo, stagedDir: staged, targetVersion: '3.4.0', previousVersion: '3.3.3',
      runInstall: async () => {
        throw { stdout: '', stderr: 'npm error code ENOSPC\nnpm error syscall mkdir\nnpm error errno -28', code: 1 };
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).not.toContain('[object Object]');
    expect(r.message).toMatch(/ran out of disk space/i);
    expect(r.message).toMatch(/ENOSPC/);
    expect(r.message).toMatch(/Nothing was changed/);
  });

  it('a non-disk install failure with no message is still words', async () => {
    const { installPlatformTree } = await import('../install-tree.js');
    const staged = makeTree(path.join(work, 'staged2'), '3.4.0');
    const r = await installPlatformTree({
      dojoDir: dojo, stagedDir: staged, targetVersion: '3.4.0', previousVersion: '3.3.3',
      runInstall: async () => { throw { stdout: '', stderr: '', code: 1 }; },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).not.toContain('[object Object]');
    expect(r.message).toMatch(/exited with code 1/);
  });
});

describe('grep guard: no child-runner rejection is rendered by String()', () => {
  it('the update path reads child failures only through the one reader', () => {
    const upd = fs.readFileSync(path.join(SRC, 'gateway', 'routes', 'update.ts'), 'utf8');
    const from = upd.indexOf('async function downloadAndInstall');
    const to = upd.indexOf('function refreshMaintenanceScripts');
    const apply = upd.indexOf('export async function applyUpdate');
    const router = upd.indexOf('export const updateRouter');
    const rollbackAt = upd.indexOf("updateRouter.post('/rollback'");
    expect(from).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(0);
    const sections = [upd.slice(from, to), upd.slice(apply, router), upd.slice(rollbackAt, upd.indexOf('// ── Apply update ──'))];
    for (const s of sections) expect(s).not.toMatch(/String\(err\)/);
    const inst = fs.readFileSync(path.join(SRC, 'update', 'install-tree.ts'), 'utf8');
    expect(inst).not.toMatch(/String\(err\)/);
    expect(inst).not.toMatch(/\.message \?\? err/);
  });
});
