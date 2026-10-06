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

// ════════════════════════════════════════════════════════════════════════════════════════
// t108 (BACKLOG line 63) — THE TWO PROPERTIES THE LINE ASKED FOR BY NAME.
//
// Line 63, verbatim: "serverIdentity() attests the install directory, not the loaded code — three
// stale/zombie dev servers caught by hand; wants a boot-time build stamp the probe reads back."
// The stamp itself landed in `ce91ab13` and the clauses above hold its writer. Re-derived at this
// head, two halves of the line had no clause:
//
//   1. THE STAMP CHANGES WHEN THE LOADED CODE CHANGES. This is the whole point — a stamp that
//      reported the same sha across two different builds would reproduce the defect with extra
//      steps, since the three zombie servers were caught by their sha NOT having moved.
//   2. THE PROBE READS IT BACK. The probe is kit-side (`behavioral/lib/serverstate.mjs` reads
//      `~/.dojo/server-boot.json` and labels provenance `boot-stamp:<source>`), so the half that
//      belongs to THIS repo is the contract: the file is at the path the probe looks at, and it
//      carries the fields the probe reads. That is what is asserted here.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('the stamp moves when the loaded code moves (BACKLOG 63)', () => {
  it('RED-CRITICAL: two different builds produce two different stamps', () => {
    process.env.DOJO_BUILD_SHA = 'a'.repeat(40);
    const first = writeBootStamp();
    expect(first).not.toBeNull();
    const firstOnDisk = readStamp();

    process.env.DOJO_BUILD_SHA = 'b'.repeat(40);
    writeBootStamp();
    const secondOnDisk = readStamp();

    expect(
      secondOnDisk.sha,
      'the stamp reported the same sha after the loaded code changed. A stamp that cannot move is '
      + 'the install-directory attestation wearing a new name — the three stale dev servers in '
      + 'BACKLOG line 63 were caught precisely by a sha that had NOT moved.',
    ).not.toBe(firstOnDisk.sha);
    expect(secondOnDisk.sha).toBe('b'.repeat(40));
  });

  it('and the same build re-stamps to the same sha — it is the CODE that decides, not the clock', () => {
    // The other direction: a stamp that changed on every boot would be noise rather than an
    // identity, and no probe could tell "restarted" from "different code".
    process.env.DOJO_BUILD_SHA = 'c'.repeat(40);
    writeBootStamp();
    const a = readStamp().sha;
    writeBootStamp();
    expect(readStamp().sha).toBe(a);
  });
});

describe('the probe can read it back — this repo\'s half of that contract', () => {
  it('the stamp is at `~/.dojo/server-boot.json`, which is the one path the probe knows', () => {
    // The kit probe hard-codes this path. A rename here silently returns it to inferring the
    // answer ABOUT the process instead of reading it FROM the process.
    expect(path.basename(bootStampPath())).toBe('server-boot.json');
    expect(bootStampPath()).toBe(path.join(HOME, '.dojo', 'server-boot.json'));
  });

  it('it carries every field the probe reads, and the pid that makes a leftover harmless', () => {
    process.env.DOJO_BUILD_SHA = 'd'.repeat(40);
    writeBootStamp();
    const stamp = readStamp() as unknown as Record<string, unknown>;
    // `pid` is load-bearing: a stamp whose pid is not the listening pid is somebody else's, which
    // is what lets a leftover file be ignored rather than believed.
    for (const field of ['pid', 'version', 'sha', 'shaSource', 'stampVersion']) {
      expect(stamp, `the probe reads \`${field}\` and the stamp no longer carries it`)
        .toHaveProperty(field);
    }
    expect(stamp.pid).toBe(process.pid);
    expect(stamp.shaSource).toBe('env');
  });
});
