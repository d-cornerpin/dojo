// ════════════════════════════════════════════════════════════════════════════════
// LOG ROTATION NEVER UNLINKS A FILE IT DID NOT WRITE.
//
// ── THE INCIDENT ──
// 2026-09-16. `logger.ts` keeps ONE backup and rotates by unlink-then-rename, and
// its 60-second throttle is a module-level variable — per process. The test suite
// was writing into the developer's real `~/.dojo` (see `tests-stay-home.test.ts`),
// so ~30 worker processes each crossed the 10 MB threshold on their own throttle
// and each performed that unlink-then-rename inside a seven-second window. The
// surviving `dojo.log.1` was 11.7 MB of test spam whose FIRST line was seven
// seconds old: the real server's entire log history had been deleted by the tests.
//
// The isolation fix means tests no longer write there at all. This file is the
// second lock: even under a log flood from any source, rotation refuses to destroy
// a backup it cannot account for.
//
// ── WHAT IS ASSERTED ──
//   PRODUCTION CONTROL  on its own files, byte for byte the old behaviour.
//   GUARD 1 ownership   a backup without this logger's signature is never unlinked.
//   GUARD 2 age         a backup younger than the throttle is never unlinked.
//   KEEP POLICY         one live file, one backup, never a `.2`.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rotateLogFile } from '../log-rotation.js';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-log-rotation-'));
const LIVE = path.join(WORK, 'dojo.log');
const BACKUP = LIVE + '.1';

const TEN_MB = 10 * 1024 * 1024;
const TWO_HOURS_AGO_S = Math.floor(Date.now() / 1000) - 7200;

/** A line shaped exactly as `createLogger` writes one. */
function ourLine(message: string): string {
  return (
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      component: 'rotation-test',
      message,
    }) + '\n'
  );
}

/** A file this logger would have written, padded past `bytes`. */
function writeOurLog(p: string, bytes: number, firstMessage: string): void {
  const head = ourLine(firstMessage);
  const filler = ourLine('filler');
  const repeats = Math.ceil((bytes - head.length) / filler.length) + 1;
  fs.writeFileSync(p, head + filler.repeat(repeats));
}

function reset(): void {
  for (const f of fs.readdirSync(WORK)) fs.rmSync(path.join(WORK, f), { recursive: true, force: true });
}

beforeEach(reset);
afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

describe('the production path, unchanged', () => {
  it('CONTROL: an oversized log with an old backup of ours rotates exactly as before', () => {
    writeOurLog(LIVE, TEN_MB + 4096, 'the live file');
    writeOurLog(BACKUP, 1024, 'the previous backup');
    fs.utimesSync(BACKUP, TWO_HOURS_AGO_S, TWO_HOURS_AGO_S);

    const liveBefore = fs.readFileSync(LIVE);

    expect(rotateLogFile(LIVE)).toBe('rotated');

    // The live file became the backup; the old backup is gone.
    expect(fs.existsSync(LIVE)).toBe(false);
    expect(fs.readFileSync(BACKUP).equals(liveBefore)).toBe(true);
    expect(fs.readFileSync(BACKUP, 'utf-8')).not.toContain('the previous backup');
  });

  it('CONTROL: a first-ever rotation, with no backup on disk yet', () => {
    writeOurLog(LIVE, TEN_MB + 4096, 'the live file');
    expect(rotateLogFile(LIVE)).toBe('rotated');
    expect(fs.existsSync(BACKUP)).toBe(true);
    expect(fs.existsSync(LIVE)).toBe(false);
  });

  it('CONTROL: a log at or under 10 MB is left completely alone', () => {
    writeOurLog(LIVE, 4096, 'small');
    const before = fs.readFileSync(LIVE);
    expect(rotateLogFile(LIVE)).toBe('under-threshold');
    expect(fs.readFileSync(LIVE).equals(before)).toBe(true);
    expect(fs.existsSync(BACKUP)).toBe(false);
  });

  it('CONTROL: no log file at all is not an error', () => {
    expect(rotateLogFile(LIVE)).toBe('no-log-file');
  });

  it('THE KEEP POLICY: one live file and one backup — a `.2` is never created', () => {
    writeOurLog(LIVE, TEN_MB + 4096, 'first');
    expect(rotateLogFile(LIVE)).toBe('rotated');
    writeOurLog(LIVE, TEN_MB + 4096, 'second');
    fs.utimesSync(BACKUP, TWO_HOURS_AGO_S, TWO_HOURS_AGO_S);
    expect(rotateLogFile(LIVE)).toBe('rotated');

    expect(fs.readdirSync(WORK).sort()).toEqual(['dojo.log.1']);
    expect(fs.readFileSync(BACKUP, 'utf-8')).toContain('second');
  });
});

describe('GUARD 1 — ownership: a file this logger did not write is never unlinked', () => {
  it('refuses when the backup path holds something that is not one of our logs', () => {
    writeOurLog(LIVE, TEN_MB + 4096, 'the live file');
    const foreign = 'the operator moved something important here\n';
    fs.writeFileSync(BACKUP, foreign);
    fs.utimesSync(BACKUP, TWO_HOURS_AGO_S, TWO_HOURS_AGO_S);

    expect(rotateLogFile(LIVE)).toBe('refused-foreign-backup');

    // Untouched, and the live log is still live — nothing was destroyed either way.
    expect(fs.readFileSync(BACKUP, 'utf-8')).toBe(foreign);
    expect(fs.existsSync(LIVE)).toBe(true);
  });

  it('refuses when the backup path is a directory', () => {
    writeOurLog(LIVE, TEN_MB + 4096, 'the live file');
    fs.mkdirSync(BACKUP);
    fs.writeFileSync(path.join(BACKUP, 'keep-me'), 'x');

    expect(rotateLogFile(LIVE)).toBe('refused-foreign-backup');
    expect(fs.existsSync(path.join(BACKUP, 'keep-me'))).toBe(true);
  });

  it('refuses when the backup path is a symlink pointing somewhere real', () => {
    writeOurLog(LIVE, TEN_MB + 4096, 'the live file');
    const target = path.join(WORK, 'someones-archive.log');
    writeOurLog(target, 1024, 'an archive the operator linked');
    fs.symlinkSync(target, BACKUP);
    fs.lutimesSync(BACKUP, TWO_HOURS_AGO_S, TWO_HOURS_AGO_S);

    // Signature or not, a symlink is not a file this logger wrote, and following it
    // would delete whatever it points at.
    expect(rotateLogFile(LIVE)).toBe('refused-foreign-backup');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toContain('an archive the operator linked');
  });

  it('accepts an EMPTY backup — a zero-byte file carries nothing to lose', () => {
    writeOurLog(LIVE, TEN_MB + 4096, 'the live file');
    fs.writeFileSync(BACKUP, '');
    fs.utimesSync(BACKUP, TWO_HOURS_AGO_S, TWO_HOURS_AGO_S);
    expect(rotateLogFile(LIVE)).toBe('rotated');
  });
});

describe('GUARD 2 — age: the storm shape is refused', () => {
  it('refuses to replace a backup written seconds ago', () => {
    writeOurLog(LIVE, TEN_MB + 4096, 'this process');
    writeOurLog(BACKUP, 1024, 'what another process just rotated');

    expect(rotateLogFile(LIVE)).toBe('refused-young-backup');
    expect(fs.readFileSync(BACKUP, 'utf-8')).toContain('what another process just rotated');
  });

  it('THE INCIDENT, REPLAYED: the second rotation inside seven seconds does not land', () => {
    // t0 — the real server's history, and a live log about to cross the threshold.
    writeOurLog(BACKUP, 1024, 'THE REAL SERVER HISTORY');
    fs.utimesSync(BACKUP, TWO_HOURS_AGO_S, TWO_HOURS_AGO_S);
    writeOurLog(LIVE, TEN_MB + 4096, 'flood wave one');

    const t0 = Date.now();
    expect(rotateLogFile(LIVE, t0)).toBe('rotated');
    // Wave one legitimately becomes the backup: it is over the threshold and the
    // previous backup was hours old. That single rotation is correct behaviour.
    expect(fs.readFileSync(BACKUP, 'utf-8')).toContain('flood wave one');

    // t0+2s — a second worker's throttle fires. Before the guard this replaced the
    // backup again, and repeated until nothing but the last seven seconds survived.
    writeOurLog(LIVE, TEN_MB + 4096, 'flood wave two');
    expect(rotateLogFile(LIVE, t0 + 2_000)).toBe('refused-young-backup');
    expect(rotateLogFile(LIVE, t0 + 4_000)).toBe('refused-young-backup');
    expect(rotateLogFile(LIVE, t0 + 6_000)).toBe('refused-young-backup');

    expect(fs.readFileSync(BACKUP, 'utf-8')).toContain('flood wave one');
    expect(fs.readFileSync(BACKUP, 'utf-8')).not.toContain('flood wave two');
  });

  it('self-heals: once the backup is older than the throttle, rotation resumes', () => {
    writeOurLog(LIVE, TEN_MB + 4096, 'the live file');
    writeOurLog(BACKUP, 1024, 'a backup from just now');
    const t0 = Date.now();

    expect(rotateLogFile(LIVE, t0)).toBe('refused-young-backup');
    expect(rotateLogFile(LIVE, t0 + 60_001)).toBe('rotated');
    expect(fs.readFileSync(BACKUP, 'utf-8')).toContain('the live file');
  });
});
