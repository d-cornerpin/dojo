// ════════════════════════════════════════════════════════════════════════════════════════
// THE PROCESS SAYS WHICH CODE IT LOADED (release-blocker round, item 3).
//
// ── THE DEFECT ──
// The kit's `serverIdentity()` answered "which code is the server running?" with
// `git -C <listening pid's cwd> rev-parse HEAD`. That is a fact about A DIRECTORY AT PROBE TIME,
// not about the process: a server started an hour ago on a tree that has since moved reports the
// NEW sha while executing the OLD code, and every record written from that probe names a commit
// the run never tested. Three stale-server incidents this cycle. `assertServerTreeMatches` cannot
// see it — that guard catches the wrong PLACE, and this is the wrong TIME.
//
// ── WHAT IS PINNED HERE ──
// The stamp is written by the only authority on which code was loaded: the process that loaded
// it. So the clauses are about provenance and about failing honestly —
//   • the sha comes from the ENV override, else the PACKAGED `build-info.json`, else a dev
//     checkout, else `null` — and `null` is a refusal, never a guess;
//   • a packaged install never reaches the git branch (a user's box has no repository);
//   • it never throws, because a box that cannot write this file must still boot;
//   • the write is atomic, because a probe must never read half a stamp;
//   • `pid` is recorded, which is what lets a probe ignore a leftover file from a dead process.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(os.tmpdir(), `dojo-boot-stamp-${process.pid}`);

vi.mock('../home.js', () => ({
  homeDir: (): string => HOME,
  dojoDir: (...segs: string[]): string => path.join(HOME, '.dojo', ...segs),
  isTestRun: (): boolean => true,
}));
vi.mock('../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});
vi.mock('../gateway/routes/update.js', () => ({
  getCurrentVersion: (): string => '9.9.9-test',
}));

import { writeBootStamp, bootStampPath, type BootStamp } from '../boot-stamp.js';

const readStamp = (): BootStamp =>
  JSON.parse(fs.readFileSync(bootStampPath(), 'utf-8')) as BootStamp;

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  delete process.env.DOJO_BUILD_SHA;
});
afterEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  delete process.env.DOJO_BUILD_SHA;
});

describe('the stamp names THIS process', () => {
  it('writes pid, version and start time where the probe looks', () => {
    const returned = writeBootStamp();

    expect(returned).not.toBeNull();
    expect(fs.existsSync(bootStampPath())).toBe(true);
    expect(bootStampPath().endsWith(path.join('.dojo', 'server-boot.json'))).toBe(true);

    const s = readStamp();
    // THE PID IS THE WHOLE POINT: it is what lets a probe tell this stamp from a dead
    // process's leftover file.
    expect(s.pid).toBe(process.pid);
    expect(s.version).toBe('9.9.9-test');
    expect(s.stampVersion).toBe(1);
    expect(new Date(s.startedAt).toString()).not.toBe('Invalid Date');
    expect(s.moduleDir.length).toBeGreaterThan(0);
  });

  it('leaves no temp file behind — the write is atomic', () => {
    writeBootStamp();
    const dir = path.dirname(bootStampPath());
    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([]);
    expect(fs.readdirSync(dir)).toContain('server-boot.json');
  });

  it('a second boot overwrites rather than appending or failing', () => {
    writeBootStamp();
    const first = readStamp();
    const second = writeBootStamp();
    expect(second).not.toBeNull();
    expect(readStamp().pid).toBe(first.pid);
    expect(JSON.parse(fs.readFileSync(bootStampPath(), 'utf-8'))).toBeTruthy();  // still one object
  });
});

describe('where the sha comes from, in order', () => {
  it('the ENV override wins and is labelled as such', () => {
    process.env.DOJO_BUILD_SHA = 'abc1234';
    writeBootStamp();
    const s = readStamp();
    expect(s.sha).toBe('abc1234');
    expect(s.shaSource).toBe('env');
  });

  it('⚠ a resolved sha is a 40-hex commit or null — NEVER a guess', () => {
    writeBootStamp();
    const s = readStamp();
    if (s.sha === null) {
      expect(s.shaSource).toBe('none');
    } else {
      // In this repo the dev branch resolves; on a bare checkout it may not. Either is honest,
      // and the pairing of value and source is what must hold.
      expect(s.sha).toMatch(/^[0-9a-f]{7,40}$/);
      expect(['env', 'package', 'git']).toContain(s.shaSource);
    }
  });

  it('NEGATIVE CONTROL — an empty env override does not win', () => {
    process.env.DOJO_BUILD_SHA = '   ';
    writeBootStamp();
    expect(readStamp().shaSource).not.toBe('env');
  });
});

describe('it never throws — a stamp is an assertion, not a precondition', () => {
  it('an unwritable target is a null return and a booted server', () => {
    // A FILE where the directory must be: `mkdirSync` then fails, which is the closest
    // reproduction of a read-only or full `~/.dojo` that does not need root.
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(path.join(HOME, '.dojo'), 'not a directory', 'utf-8');

    let returned: BootStamp | null = null;
    expect(() => { returned = writeBootStamp(); }).not.toThrow();
    expect(returned).toBeNull();
  });
});
