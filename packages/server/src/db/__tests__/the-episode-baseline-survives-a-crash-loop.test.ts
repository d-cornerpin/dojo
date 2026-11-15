// ════════════════════════════════════════════════════════════════════════════════════════
// THE RESTORE POINT SURVIVES THE FAILURE IT EXISTS FOR.  (UPDATE-INTEGRITY U0, change 4.)
//
// ── THE DEFECT THIS FILE EXISTS FOR ─────────────────────────────────────────────────────
// `takeSnapshot` kept the newest TWO pre-migration snapshots and deleted the rest, ordered
// by mtime. That policy is safe exactly until the chain starts failing — and then it eats
// the one file it was written to protect.
//
// W52 measured it on the reproduced incident body. The first boot wrote the genuine restore
// point, `dojo-pre-1-of-3-…db` — the body as it was BEFORE the .17 chain touched it.
// The chain then aborted at `135b`, launchd's KeepAlive (ThrottleInterval=10) restarted the
// process, and each retry wrote another snapshot — of the ALREADY-BROKEN 135 state. The
// third one pushed the good file out. About thirty seconds, start to finish. The user's two
// surviving 1.57 GB "restore points" were both snapshots of the broken state; restoring
// either one put him back exactly where he was.
//
// ── THE RULE ────────────────────────────────────────────────────────────────────────────
// The episode's BASELINE is pinned: of the snapshots taken on the way to the SAME target
// level, the one taken from the lowest applied level is the furthest back this box can
// still go, and it is never pruned. The cap is otherwise unchanged, so retention moves from
// "the newest 2" to "the newest 2 plus one pinned baseline" — three files, still bounded,
// and the pin releases itself when a later release moves the target.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensurePreChainBackup, readLastMigrationBackup } from '../migration-backup.js';

/** A synthetic chain whose file names carry only what the snapshot namer reads: the number. */
const AT_109 = '109_a.sql';
const AT_135 = '135_b.sql';
const AT_900 = '900_z.sql';
const CHAIN = [AT_109, AT_135, AT_900];

let scratch: string;
let dbFile: string;
let db: Database.Database;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'w53-snap-'));
  dbFile = path.join(scratch, 'dojo.db');
  db = new Database(dbFile);
  db.exec(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             updated_at TEXT NOT NULL DEFAULT (datetime('now')));
           CREATE TABLE payload (id INTEGER PRIMARY KEY, body TEXT);
           INSERT INTO payload (body) VALUES ('the data that must survive');`);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const backupsDir = (): string => path.join(scratch, 'backups');

const snapshots = (): string[] => (fs.existsSync(backupsDir())
  ? fs.readdirSync(backupsDir()).filter((f) => f.endsWith('.db')).sort()
  : []);

/** One boot's pre-chain snapshot, at a wall-clock instant of the test's choosing. */
function boot(atIso: string, pending: string[]): void {
  vi.setSystemTime(new Date(atIso));
  ensurePreChainBackup(db, CHAIN, pending);
}

const levels = (): string[] => snapshots().map((f) => f.replace(/-\d{4}-\d{2}.*$/, ''));

// ────────────────────────────────────────────────────────────────────────────────────────

describe('the fixture reproduces the crash loop that ate the restore point', () => {
  it('POSITIVE: the first boot names the snapshot after the level it is leaving', () => {
    boot('2026-08-29T17:37:41.000Z', [AT_135, AT_900]);
    expect(snapshots()).toHaveLength(1);
    expect(snapshots()[0]).toMatch(/^dojo-pre-1-of-3-/);
    expect(readLastMigrationBackup(db)?.status).toBe('written');
  });

  it('POSITIVE: a retry after the chain aborted at 135 names ITS level, not the old one', () => {
    boot('2026-08-29T17:37:41.000Z', [AT_135, AT_900]);
    boot('2026-08-29T17:37:52.000Z', [AT_900]);
    expect(levels()).toEqual(['dojo-pre-1-of-3', 'dojo-pre-2-of-3']);
  });
});

describe("the crash loop can no longer evict the episode's own baseline", () => {
  it('POSITIVE: W52 REPRO — two retries eleven seconds apart, and pre-109 is still there', () => {
    boot('2026-08-29T17:37:41.000Z', [AT_135, AT_900]);   // the good restore point
    boot('2026-08-29T17:37:52.000Z', [AT_900]);           // KeepAlive retry 1
    boot('2026-08-29T17:38:03.000Z', [AT_900]);           // KeepAlive retry 2 — used to evict it
    expect(snapshots().filter((f) => f.startsWith('dojo-pre-1-of-3'))).toHaveLength(1);
    expect(snapshots()).toHaveLength(3);
  });

  it('POSITIVE: it survives a loop that runs all night, and retention stays bounded at 3', () => {
    boot('2026-08-29T17:37:41.000Z', [AT_135, AT_900]);
    for (let i = 0; i < 40; i++) {
      boot(`2026-08-29T18:${String(i).padStart(2, '0')}:00.000Z`, [AT_900]);
    }
    expect(snapshots().filter((f) => f.startsWith('dojo-pre-1-of-3'))).toHaveLength(1);
    expect(snapshots()).toHaveLength(3);
  });

  it('POSITIVE: the pinned file is a real, readable database — not just a name on disk', () => {
    boot('2026-08-29T17:37:41.000Z', [AT_135, AT_900]);
    boot('2026-08-29T17:37:52.000Z', [AT_900]);
    boot('2026-08-29T17:38:03.000Z', [AT_900]);
    const pinned = snapshots().find((f) => f.startsWith('dojo-pre-1-of-3'))!;
    const copy = new Database(path.join(backupsDir(), pinned), { readonly: true });
    expect((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
      .integrity_check).toBe('ok');
    expect((copy.prepare('SELECT body FROM payload').get() as { body: string }).body)
      .toBe('the data that must survive');
    copy.close();
  });
});

describe('the cap is still a cap', () => {
  it('NEGATIVE: six boots at the SAME level keep three — the episode\'s first, plus the '
    + 'newest two. Never "keep everything"', () => {
    // Every snapshot here is of the same level, so the pin resolves to the EARLIEST of
    // them: the one taken before the loop started churning. That is the literal episode
    // baseline, and it is the conservative direction. What must never happen is growth.
    for (let i = 0; i < 6; i++) {
      boot(`2026-08-29T19:0${i}:00.000Z`, [AT_900]);
    }
    expect(snapshots()).toHaveLength(3);
    const kept = snapshots();
    expect(kept.some((f) => f.includes('19-00-00'))).toBe(true);   // the first
    expect(kept.some((f) => f.includes('19-05-00'))).toBe(true);   // the newest
    expect(kept.some((f) => f.includes('19-02-00'))).toBe(false);  // the middle is gone
  });

  it('NEGATIVE: the pin RELEASES when a later release moves the target', () => {
    boot('2026-08-29T17:37:41.000Z', [AT_135, AT_900]);
    boot('2026-08-29T17:37:52.000Z', [AT_900]);
    boot('2026-08-29T17:38:03.000Z', [AT_900]);
    expect(snapshots()).toHaveLength(3);
    // A later release adds 901: a NEW episode, with a new baseline of its own.
    vi.setSystemTime(new Date('2026-09-02T09:00:00.000Z'));
    ensurePreChainBackup(db, [...CHAIN, '901_next.sql'], ['901_next.sql']);
    expect(snapshots()).toHaveLength(2);
    expect(snapshots().some((f) => f.startsWith('dojo-pre-3-of-4'))).toBe(true);
    expect(snapshots().some((f) => f.startsWith('dojo-pre-1-of-3'))).toBe(false);
  });

  it('NEGATIVE: a foreign file in the backups directory is never pinned and never counted', () => {
    boot('2026-08-29T17:37:41.000Z', [AT_135, AT_900]);
    fs.writeFileSync(path.join(backupsDir(), 'dojo-pre-hand-made.db'), 'not a snapshot');
    boot('2026-08-29T17:37:52.000Z', [AT_900]);
    boot('2026-08-29T17:38:03.000Z', [AT_900]);
    expect(snapshots().some((f) => f === 'dojo-pre-hand-made.db')).toBe(false);
    expect(snapshots().filter((f) => f.startsWith('dojo-pre-1-of-3'))).toHaveLength(1);
  });
});

describe('an update that lands across several starts keeps its first copy, even when the target moves', () => {
  const AT_901 = '901_next.sql';
  const LONG_CHAIN = [...CHAIN, AT_901];

  it('POSITIVE: three starts inside one unfinished update keep the first copy; once it finishes the newest two rule applies', () => {
    boot('2026-08-29T17:37:41.000Z', [AT_135, AT_900]);                        // the update's first copy: 109 to 900
    vi.setSystemTime(new Date('2026-08-29T17:37:52.000Z'));
    ensurePreChainBackup(db, LONG_CHAIN, [AT_900, AT_901]);                   // a newer release arrives before 900 landed
    vi.setSystemTime(new Date('2026-08-29T17:38:03.000Z'));
    ensurePreChainBackup(db, LONG_CHAIN, [AT_900, AT_901]);
    expect(snapshots().filter((f) => f.startsWith('dojo-pre-1-of-3'))).toHaveLength(1);
    expect(snapshots()).toHaveLength(3);

    vi.setSystemTime(new Date('2026-08-30T09:00:00.000Z'));
    ensurePreChainBackup(db, [...LONG_CHAIN, '902_more.sql'], ['902_more.sql']);   // the update finished at 901
    expect(snapshots()).toHaveLength(2);
    expect(snapshots().some((f) => f.startsWith('dojo-pre-1-of-3'))).toBe(false);
  });
});

describe('progress is measured along the chain, not by the highest number', () => {
  const BRIDGED = ['218_a.sql', '219_b.sql', '220_c.sql', '900_z.sql', '901_y.sql'];
  const at = (iso: string, chain: string[], pending: string[]): void => {
    vi.setSystemTime(new Date(iso));
    ensurePreChainBackup(db, chain, pending);
  };

  it('POSITIVE: with 900 and 901 applied, a crash loop over later lower-numbered files keeps the first copy', () => {
    at('2026-11-20T10:00:00.000Z', BRIDGED, ['219_b.sql', '220_c.sql']);   // the update's first copy
    at('2026-11-20T10:00:11.000Z', BRIDGED, ['220_c.sql']);                 // 219 landed, 220 threw
    at('2026-11-20T10:00:22.000Z', BRIDGED, ['220_c.sql']);
    expect(snapshots().filter((f) => f.includes('10-00-00'))).toHaveLength(1);
    expect(snapshots()).toHaveLength(3);

    at('2026-11-21T09:00:00.000Z', [...BRIDGED, '221_d.sql'], ['221_d.sql']);   // the update finished
    expect(snapshots()).toHaveLength(2);
    expect(snapshots().some((f) => f.includes('10-00-00'))).toBe(false);
  });

  it('NEGATIVE: a copy named the older way is pruned by age and never pinned', () => {
    fs.mkdirSync(backupsDir(), { recursive: true });
    fs.writeFileSync(path.join(backupsDir(), 'dojo-pre-109-to-900-2026-08-29T17-37-41.db'), '');
    fs.utimesSync(path.join(backupsDir(), 'dojo-pre-109-to-900-2026-08-29T17-37-41.db'), new Date('2026-08-29'), new Date('2026-08-29'));
    at('2026-11-20T10:00:00.000Z', BRIDGED, ['219_b.sql', '220_c.sql']);
    at('2026-11-20T10:00:11.000Z', BRIDGED, ['220_c.sql']);
    at('2026-11-20T10:00:22.000Z', BRIDGED, ['220_c.sql']);
    expect(snapshots().some((f) => f.includes('-to-'))).toBe(false);
    expect(snapshots()).toHaveLength(3);
  });
});
