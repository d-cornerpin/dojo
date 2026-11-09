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
import { makeTree } from './safe-install-fixtures.js';

const home = process.env.DOJO_HOME as string;
const dojo = path.join(home, '.dojo');
const platform = path.join(dojo, 'platform');
const work = path.join(home, 't219-apply');
const savedPath = process.env.PATH;

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

/** A `curl` that replays `stderr` byte for byte (carriage returns and all), records its argv, exits `code`. */
function standInCurlRaw(code: number, stderr: string): void {
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(work, 'curl-stderr'), stderr);
  fs.writeFileSync(path.join(bin, 'curl'),
    `#!/bin/sh\ntouch "${path.join(work, 'curl-ran')}"\necho "$@" > "${path.join(work, 'curl-args')}"\ncat "${path.join(work, 'curl-stderr')}" >&2\nexit ${code}\n`, { mode: 0o755 });
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

/**
 * What a real full-disk download printed (t217 leg 6, quoted in the t236 installer report): curl's
 * progress meter, its `\r`-separated redraws, a warning about the file it could not write, and the
 * cause on the last line. Built with real carriage returns, as the pipe delivers them.
 */
const LEG6_STDERR = [
  '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current',
  '                                 Dload  Upload   Total   Spent    Left  Speed',
  '  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0',
  '  0 20.8M    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0',
  'Warning: Failed to create the file /Volumes/Test/dojo-platform: No space left on device',
  '  0 20.8M    0 16384    0     0   9531      0  0:38:07  0:00:01  0:38:06  9531',
  'curl: (23) Failure writing output to destination, passed 16384 returned 337',
].join('\r\n').replace(/\r\n(?=  0 )/g, '\r');

const LEG6_LINE = 'curl: (23) Failure writing output to destination, passed 16384 returned 337';

describe('G22: the technical detail of a full-disk update is one plain line', () => {
  it('curl\'s own error line is the detail, not the progress meter around it', async () => {
    const { childFailureText } = await import('../child-failure.js');
    expect(childFailureText({ stdout: '', stderr: LEG6_STDERR, code: 23 })).toBe(LEG6_LINE);
  });

  it('a plain "No space left on device" stderr is that line', async () => {
    const { childFailureText } = await import('../child-failure.js');
    expect(childFailureText({ stdout: '', stderr: 'No space left on device\n', code: 1 })).toBe('No space left on device');
  });

  it('a child with only an exit code is "exited with code 1"', async () => {
    const { childFailureText } = await import('../child-failure.js');
    expect(childFailureText({ stdout: '', stderr: '', code: 1 })).toBe('exited with code 1');
  });

  it('with no recognised tool line, the stderr tail has its meter rows removed and starts at a whole word', async () => {
    const { childFailureText } = await import('../child-failure.js');
    const tail = `${LEG6_STDERR.split('\r\n')[0]}\r  0 20.8M 0 0 0 0 0 0 --:--:-- --:--:-- --:--:-- 0\r${'/Users/someone/long/path/segment '.repeat(30)}final words`;
    const said = childFailureText({ stdout: '', stderr: tail, code: 1 });
    expect(said).not.toMatch(/--:--:--|Dload|20\.8M/);
    expect(said).toMatch(/final words$/);
    expect(said.length).toBeLessThanOrEqual(305);
    expect(said).not.toMatch(/\n|\r/);
    expect(said.replace(/^…/, '')).toMatch(/^\//);   // starts at a whole path, never mid-word
  });

  it('through applyUpdate on a full volume, the sentence carries that one line and none of the meter', async () => {
    standInCurlRaw(23, LEG6_STDERR);
    stubVolume(100);
    const { applyUpdate } = await import('../../gateway/routes/update.js');
    const r = await applyUpdate('stable');
    expect(r.message).toMatch(/ran out of disk space/i);
    expect(r.message).toContain(`(Technical detail: ${LEG6_LINE})`);
    expect(r.message).not.toMatch(/20\.8M|--:--:--|Dload/);
    expect(r.status).toBe(507);
  }, 60_000);

  it('the download keeps curl\'s progress meter: it is the only output the idle bound can hear', async () => {
    standInCurlRaw(23, LEG6_STDERR);
    stubVolume(100);
    const { applyUpdate } = await import('../../gateway/routes/update.js');
    await applyUpdate('stable');
    const argv = fs.readFileSync(path.join(work, 'curl-args'), 'utf8').trim().split(/\s+/);
    // The body goes to a file (-o), so curl's progress meter on stderr is the ONLY thing the download
    // prints; silence it (-s, -sS, --silent, --no-progress-meter) and a healthy download longer than
    // the idle window is killed as "quiet" (t114).
    const silencing = argv.filter((a) => /^-[A-Za-z]*s[A-Za-z]*$/.test(a) || a === '--silent' || a === '--no-progress-meter');
    expect(silencing, 'the download argv silences curl\'s progress meter').toEqual([]);

    // And the consequence, driven through the real idle bound at second scale: a curl that prints
    // progress as the argv allows (the meter, unless silenced) for 3 s survives a 1 s idle window.
    const meter = silencing.length === 0;
    const script = meter ? 'for i in 1 2 3 4 5 6; do echo "  12.3%" 1>&2; sleep 0.5; done' : 'sleep 3';
    const { attachIdleBound } = await import('../../child-idle-bound.js');
    const { spawn } = await import('node:child_process');
    await expect(attachIdleBound(spawn('/bin/sh', ['-c', script]), { idleMs: 1_000, ceilingMs: 30_000 })).resolves.toBeDefined();
    const silentRun = attachIdleBound(spawn('/bin/sh', ['-c', 'sleep 3']), { idleMs: 1_000, ceilingMs: 30_000 });
    await expect(silentRun, 'CONTROL: a silent child IS killed by the same bound').rejects.toBeDefined();
  }, 60_000);
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
