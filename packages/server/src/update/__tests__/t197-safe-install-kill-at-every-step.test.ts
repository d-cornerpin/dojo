// ════════════════════════════════════════════════════════════════════════════════════════
// t197 (v3.4 F2) — AN UPDATE KILLED AT ANY STEP LEAVES THE BOX WHOLLY OLD OR WHOLLY NEW.
//
// THE DEFECT (v34-inv-platform.md item 4, re-derived at e63aa3d7): the updater built the new
// tree IN the live directory — `cp -R` a backup, then `rsync -a --delete` one top-level entry at
// a time over `~/.dojo/platform`, then `npm install` inside the live tree. A crash between two
// of those copies left a MIXED tree (some directories new, some old), and a crash during the
// install left new code over half-written dependencies. There was no instant at which the live
// tree was either wholly old or wholly new.
//
// THE PROPERTY, judged the way an owner judges an update: whatever moment the power goes out,
// what he gets back is either the version he had or the version he asked for — never a third
// thing — and the bookkeeping the watchdog reads says which one, truthfully.
//
// HOW: the REAL installer runs in a child process against a scratch HOME and SIGKILLs itself the
// instant a step completes (or the fake npm SIGKILLs it mid-install). Then the two repairs that
// exist run exactly as they would on a box: `rollback.sh --heal` (the watchdog's repair when the
// platform folder is missing) and the boot sentinel (the first thing the next boot does).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeBox, makeTree, treeHash, runInstaller, runRollbackSh, readJson, versionAt, type Box,
} from './t197-safe-install-fixtures.js';

const OLD = '3.3.3';
const NEW = '3.4.0';
let box: Box;
let source: string;
let oldHash: string | null;
let newHash: string | null;

/** The hash of a COMPLETE, uninterrupted install — what "wholly new" means, measured. */
beforeAll(() => {
  const ref = makeBox('t197-ref-');
  try {
    makeTree(ref.platform, OLD, { native: true });
    const src = makeTree(path.join(ref.home, 'src'), NEW);
    const run = runInstaller(ref, { SOURCE_TREE: src, TARGET_VERSION: NEW, PREVIOUS_VERSION: OLD, NPM_MODE: 'ok' });
    expect(run.result, run.out).toMatchObject({ ok: true });
    newHash = treeHash(ref.platform);
  } finally { fs.rmSync(ref.home, { recursive: true, force: true }); }
}, 120_000);

beforeEach(() => {
  box = makeBox('t197-kill-');
  makeTree(box.platform, OLD, { native: true });
  oldHash = treeHash(box.platform);
  source = makeTree(path.join(box.home, 'src'), NEW);
});
afterEach(() => { fs.rmSync(box.home, { recursive: true, force: true }); });

const marker = (): Record<string, unknown> | null => readJson(path.join(box.dojo, 'update-state.json'));
const wholly = (): 'old' | 'new' | 'missing' | 'MIXED' => {
  const h = treeHash(box.platform);
  if (h === null) return 'missing';
  if (h === oldHash) return 'old';
  if (h === newHash) return 'new';
  return 'MIXED';
};

// Every point at which the process can die. `during-npm` is the fake npm killing it mid-install.
const KILL_POINTS = ['deps-cloned', 'during-npm', 'deps-installed', 'verified', 'marked', 'aside', 'swapped'] as const;

describe('a kill at any step leaves the box wholly old or wholly new, and the record says which', () => {
  for (const at of KILL_POINTS) {
    it(`killed at ${at}`, () => {
      const run = runInstaller(box, {
        SOURCE_TREE: source, TARGET_VERSION: NEW, PREVIOUS_VERSION: OLD,
        NPM_MODE: at === 'during-npm' ? 'kill' : 'ok', KILL_AT: at === 'during-npm' ? '' : at,
      });
      expect(run.signal, `the installer must really have died at ${at}\n${run.out}`).toBe('SIGKILL');

      // 1. The instant after the crash: old, new, or (only between the two renames) missing.
      const now = wholly();
      expect(now, `never a mixed tree (killed at ${at})`).not.toBe('MIXED');
      if (at === 'aside') expect(now).toBe('missing');
      else expect(now).toBe(at === 'swapped' ? 'new' : 'old');

      // 2. The watchdog's repair for a missing platform folder. On a box with the folder in
      //    place it must change nothing at all.
      const heal = runRollbackSh(box, ['--heal']);
      expect(heal.code, heal.out).toBe(0);
      const healed = wholly();
      expect(['old', 'new'], `after the repair (killed at ${at})`).toContain(healed);
      if (now !== 'missing') expect(healed, 'a heal on a whole box is a no-op').toBe(now);
      // Cut off between the renames with a verified staged tree in hand: the update is FINISHED.
      if (at === 'aside') expect(healed).toBe('new');

      // 3. The next boot. "Healthy" must mean healthy: the record names what is actually live.
      const boot = runInstaller(box, { DRIVER_MODE: 'boot' });
      const m = boot.result as Record<string, unknown> | null;
      if (healed === 'new') {
        expect(m?.phase, 'the new build is booting and the watchdog supervises it').toBe('booting-new');
        expect(m?.bootAttempts).toBe(1);
      } else if (at === 'marked') {
        // The episode was opened and the swap never happened: nothing changed, and the
        // watchdog is told so it can say so.
        expect(m?.phase).toBe('interrupted');
        expect(m?.targetVersion).toBe(NEW);
      } else {
        expect(m, 'no episode was ever opened, so there is nothing to record').toBeNull();
      }
      expect(versionAt(box.platform)).toBe(healed === 'new' ? NEW : OLD);
    }, 60_000);
  }
});

describe('a failed preparation changes nothing and cleans up after itself', () => {
  it('npm failing in staging: live untouched, staging removed, plain words', () => {
    const run = runInstaller(box, { SOURCE_TREE: source, TARGET_VERSION: NEW, PREVIOUS_VERSION: OLD, NPM_MODE: 'fail' });
    const r = run.result as { ok: boolean; message: string };
    expect(r.ok, run.out).toBe(false);
    expect(wholly()).toBe('old');
    expect(r.message).toMatch(/Nothing was changed/);
    expect(r.message).toContain(OLD);
    expect(marker(), 'no episode is opened for an install that never reached the swap').toBeNull();
    const staged = fs.readdirSync(box.dojo).filter((n) => n.startsWith('platform.staging-'))
      .map((n) => path.join(box.dojo, n, 'platform')).filter((p) => fs.existsSync(p));
    expect(staged, 'the half-prepared tree is removed').toEqual([]);
  }, 60_000);

  it('a full disk during preparation is named as a full disk', () => {
    const run = runInstaller(box, { SOURCE_TREE: source, TARGET_VERSION: NEW, PREVIOUS_VERSION: OLD, NPM_MODE: 'enospc' });
    const r = run.result as { ok: boolean; message: string };
    expect(r.ok).toBe(false);
    expect(wholly()).toBe('old');
    expect(r.message).toMatch(/ran out of disk space/i);
    expect(r.message).toMatch(/still running|Nothing was changed/i);
  }, 60_000);

  it('MUTANT GUARD: a staged tree whose database module will not load is refused before the swap', () => {
    // No live dependencies to clone and an npm that leaves the native module out: exactly the
    // tree that would boot into a crash loop. The verify step must refuse it.
    fs.rmSync(path.join(box.platform, 'node_modules'), { recursive: true, force: true });
    oldHash = treeHash(box.platform);
    const run = runInstaller(box, { SOURCE_TREE: source, TARGET_VERSION: NEW, PREVIOUS_VERSION: OLD, NPM_MODE: 'nonative' });
    const r = run.result as { ok: boolean; message: string };
    expect(r.ok, run.out).toBe(false);
    expect(r.message).toMatch(/database module/i);
    expect(wholly()).toBe('old');
  }, 60_000);

  it('a staged tree that is not the version it claims is refused', () => {
    const run = runInstaller(box, { SOURCE_TREE: source, TARGET_VERSION: '3.4.1', PREVIOUS_VERSION: OLD, NPM_MODE: 'ok' });
    expect((run.result as { ok: boolean }).ok).toBe(false);
    expect(wholly()).toBe('old');
  }, 60_000);
});

describe('the boot settles only what the new installer wrote', () => {
  it('CONTROL: a marker from an OLD in-place updater (no staged tree recorded) is left exactly as it was', () => {
    // A 3.3.x updater cut off mid-copy leaves a tree nobody can call whole; this boot cannot
    // tell which half it is, so it must not invent an answer. That episode stays with the
    // machinery that already owns it.
    const legacy = { phase: 'pending-update', targetVersion: NEW, previousVersion: OLD,
      backupDir: path.join(box.dojo, `platform.backup-${OLD}`), writeSeq: 4 };
    fs.writeFileSync(path.join(box.dojo, 'update-state.json'), JSON.stringify(legacy));
    const boot = runInstaller(box, { DRIVER_MODE: 'boot' });
    expect((boot.result as Record<string, unknown>).phase).toBe('pending-update');
    expect((boot.result as Record<string, unknown>).writeSeq).toBe(4);
  }, 60_000);
});

describe('leftovers of a dead installer are found and only those', () => {
  it('a killed install leaves a work dir the boot prune can see is orphaned', async () => {
    runInstaller(box, { SOURCE_TREE: source, TARGET_VERSION: NEW, PREVIOUS_VERSION: OLD, NPM_MODE: 'ok', KILL_AT: 'verified' });
    const { deadInstallWorkDirs } = await import('../install-tree.js');
    const dead = deadInstallWorkDirs(box.dojo);
    expect(dead.length).toBe(1);
    // A live installer's work dir (this test process stands in for one) is never listed.
    fs.mkdirSync(path.join(box.dojo, `platform.staging-${process.pid}-1`));
    expect(deadInstallWorkDirs(box.dojo)).toEqual(dead);
  }, 60_000);
});
