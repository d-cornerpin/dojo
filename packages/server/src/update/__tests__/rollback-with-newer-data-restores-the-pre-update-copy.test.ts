// rollback.sh, run for real in a scratch HOME (safe-install-fixtures): when the data's last step is one the
// build it restores does not have, it also puts back the data copy the update episode recorded, and the
// newer data is kept under a dated name. The data cases are shared with the runner's test.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { makeBox, makeTreeWithSteps, levelDb, whichDb, runRollbackSh, versionAt, type Box } from './safe-install-fixtures.js';
import { migrationFileNames } from '../../db/migrations.js';
import CASES from '../../db/__tests__/fixtures/data-ahead-cases.json' with { type: 'json' };

let b: Box;
const live = (): string => path.join(b.dojo, 'data', 'dojo.db');
const setAside = (): string[] => fs.readdirSync(path.join(b.dojo, 'data', 'backups')).filter((f) => f.startsWith('dojo-replaced-'));
const result = (): string => fs.readFileSync(path.join(b.dojo, 'rollback-result'), 'utf-8');

afterEach(() => { fs.rmSync(b.home, { recursive: true, force: true }); });

/** The live build, the build a rollback restores, the live data, and the episode's recorded copy. */
function box(o: { current: string[]; old: string[]; applied: string[]; copy?: boolean }): void {
  b = makeBox('rollback-data-');
  makeTreeWithSteps(b.platform, '3.5.0', o.current);
  const backupDir = makeTreeWithSteps(path.join(b.dojo, 'platform.backup-3.4.1'), '3.4.1', o.old);
  levelDb(live(), o.applied, 'newer');
  const dataBackup = o.copy === false ? null
    : levelDb(path.join(b.dojo, 'data', 'backups', 'dojo-pre-1-of-2-2026-11-16T10-00-00.db'), o.old.slice(0, 1), 'before');
  fs.writeFileSync(path.join(b.dojo, 'update-state.json'), JSON.stringify({
    phase: 'rolled-back', targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir, dataBackup,
    migrationsRanDuringEpisode: true, rollbackCount: 1, writeSeq: 4,
  }));
}
const ahead = { current: ['209_a.sql', '210_b.sql'], old: ['209_a.sql'], applied: ['209_a.sql', '210_b.sql'] };

describe('rollback with newer data restores the pre-update copy', () => {
  // The fixture's before-901 case is proven below with the real file list of the old build.
  for (const c of CASES.filter((x) => !x.case.startsWith('the update fails before 901'))) {
    it(`${c.case}: ${c.ahead ? 'program and data go back' : 'only the program goes back'}`, () => {
      box({ current: [...new Set([...c.build, ...c.applied])], old: c.build, applied: c.applied });
      const r = runRollbackSh(b, ['--auto']);
      expect(r.code, r.out).toBe(0);
      expect(versionAt(b.platform)).toBe('3.4.1');
      expect(whichDb(live())).toBe(c.ahead ? 'before' : 'newer');
      expect(setAside().map((f) => whichDb(path.join(b.dojo, 'data', 'backups', f)))).toEqual(c.ahead ? ['newer'] : []);
      expect(result()).toMatch(c.ahead ? /^restored-with-data\t.*together with your data/ : /^restored\t.*did not need to change/);
    });
  }

  it("the owner's update dying before 901: the files of v3.5.0-preflight.3 with 210 to 218 applied after 900", () => {
    // The tag's files are this tree's files numbered up to 209, plus 900 (checked against the tag).
    const files = migrationFileNames();
    const old = files.filter((f) => parseInt(f, 10) <= 209 || parseInt(f, 10) === 900);
    box({ current: files, old, applied: [...old, ...files.filter((f) => parseInt(f, 10) >= 210 && parseInt(f, 10) <= 218)] });
    const r = runRollbackSh(b, ['--auto']);
    expect(r.code, r.out).toBe(0);
    expect(versionAt(b.platform)).toBe('3.4.1');
    expect(whichDb(live())).toBe('before');
    expect(setAside()).toHaveLength(1);
    expect(result()).toMatch(/^restored-with-data\t/);
  });

  it('asked for its target, it names the build and the time of the data copy that goes with it', () => {
    box(ahead);
    const lines = runRollbackSh(b, ['--print-target']).out.trim().split('\n');
    expect(lines[0]).toBe(path.join(b.dojo, 'platform.backup-3.4.1'));
    expect(lines[1]).toMatch(/^data \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('changes nothing and says why when the data is ahead and no copy was recorded', () => {
    box({ ...ahead, copy: false });
    expect(runRollbackSh(b, ['--print-target']).out.trim().split('\n')[1]).toBe('data none');
    const r = runRollbackSh(b, ['--auto']);
    expect(r.code).toBe(1);
    expect(versionAt(b.platform)).toBe('3.5.0');
    expect(whichDb(live())).toBe('newer');
    expect(result()).toMatch(/^unchanged\t.*no copy of it from before the update\. Nothing was changed.*"What if there is no backup\?"/);
    expect(result()).not.toMatch(/menu bar/);
  });

  it('another rollback holding the lock: says so, and changes nothing', () => {
    box(ahead);
    fs.mkdirSync(path.join(b.dojo, 'rollback.lock'));
    fs.writeFileSync(path.join(b.dojo, 'rollback.lock', 'pid'), String(process.pid));
    expect(runRollbackSh(b, ['--auto']).code).toBe(1);
    expect(result()).toMatch(/^unchanged\t.*another rollback or restore was already running/);
  });

  // A shutdown sends TERM to the scripts; these stubs send it at the named step (cp is restore-db.sh's child,
  // whose parent is rollback.sh; mv is rollback.sh's own).
  const term = (tool: 'cp' | 'mv', when: string): void => fs.writeFileSync(path.join(b.bin, tool),
    `#!/bin/sh\nfor last; do :; done\nif ${when}; then\n${tool === 'cp'
      ? 'kill -TERM $PPID $(ps -o ppid= -p $PPID); head -c 512 "$2" > "$last"; exit 1'
      : 'kill -TERM $PPID; exec /bin/mv "$@"'}\nfi\nexec /bin/${tool} "$@"\n`, { mode: 0o755 });
  const whole = (file: string): boolean => spawnSync('sqlite3', [file, 'PRAGMA integrity_check;'], { encoding: 'utf-8' }).stdout.trim() === 'ok';

  it('a stop half-way through copying the data back leaves the newer data whole, and says nothing changed', () => {
    box(ahead);
    term('cp', `case "$2" in */dojo-pre-*) case "$last" in */data/dojo.db) true;; *) false;; esac;; *) false;; esac`);
    runRollbackSh(b, ['--auto']);
    expect(whole(live())).toBe(true);
    expect(whichDb(live())).toBe('newer');
    expect(result()).toMatch(/^unchanged\t.*stopped before it finished\. Nothing was changed/);
  });

  it('a stop that also cuts the copy putting the newer data back is reported as data that cannot be read', () => {
    box(ahead);
    fs.writeFileSync(path.join(b.bin, 'cp'), [
      '#!/bin/sh', 'for last; do :; done',
      'case "$2" in */dojo-pre-*) kill -TERM $PPID $(ps -o ppid= -p $PPID); head -c 512 "$2" > "$last"; exit 1;;',
      '  */dojo-replaced-*) head -c 512 "$2" > "$last"; exit 1;; esac', 'exec /bin/cp "$@"',
    ].join('\n') + '\n', { mode: 0o755 });
    runRollbackSh(b, ['--auto']);
    expect(whole(live())).toBe(false);
    expect(setAside().map((f) => whichDb(path.join(b.dojo, 'data', 'backups', f)))).toEqual(['newer']);
    expect(result()).toMatch(/^failed\t.*your data could not be read.*dojo-replaced-<date>\.db.*Please get help/);
    expect(result()).not.toMatch(/Nothing was changed/);
  });

  it('a stop to restore-db.sh alone after its copy finished reports the data that is in place', () => {
    box(ahead);
    // TERM goes to restore-db.sh itself: the outermost ancestor running it (its subshells carry the same name).
    fs.writeFileSync(path.join(b.bin, 'sqlite3'), [
      '#!/bin/sh', 'case "$*" in */data/dojo.db*integrity_check*)',
      '  p=$PPID; t=; while [ "$p" -gt 1 ]; do case "$(ps -o command= -p $p)" in *restore-db.sh*) t=$p;; esac; p=$(ps -o ppid= -p $p | tr -d " "); done',
      '  kill -TERM $t;; esac', 'exec /usr/bin/sqlite3 "$@"',
    ].join('\n') + '\n', { mode: 0o755 });
    expect(runRollbackSh(b, ['--auto']).code).toBe(1);
    expect(whichDb(live())).toBe('before');
    expect(versionAt(b.platform)).toBe('3.5.0');
    expect(result()).toMatch(/^failed\t.*your data was put back to the copy from before the update, but .*newer version is still installed/);
  });

  it('a stop after the data went back and while the program is swapped says exactly that', () => {
    box(ahead);
    term('mv', `[ "$1" = "${'$'}HOME/.dojo/platform" ]`);
    runRollbackSh(b, ['--auto']);
    expect(whole(live())).toBe(true);
    expect(whichDb(live())).toBe('before');
    expect(setAside().map((f) => whichDb(path.join(b.dojo, 'data', 'backups', f)))).toEqual(['newer']);
    expect(result()).toMatch(/^failed\t.*swapping the program \(your data had already been put back.*may have no program to run/);
  });

  it('changes nothing when the server is still answering after it was told to stop', () => {
    box(ahead);
    fs.writeFileSync(path.join(b.bin, 'lsof'), '#!/bin/sh\necho "node 1 u 20u IPv4 TCP *:1 (LISTEN)"\n', { mode: 0o755 });
    const r = runRollbackSh(b, ['--auto'], { DOJO_STOP_WAIT: '2' });
    expect(r.code).toBe(1);
    expect(versionAt(b.platform)).toBe('3.5.0');
    expect(whichDb(live())).toBe('newer');
    expect(setAside()).toEqual([]);
    expect(result()).toMatch(/^unchanged\t.*did not stop in time/);
    expect(fs.existsSync(path.join(b.home, 'up')), 'the services it stopped are started again').toBe(true);
  });

  it('--heal puts a build back over a missing program folder whatever the data, and says the data is ahead', () => {
    box(ahead);
    fs.rmSync(b.platform, { recursive: true });
    const r = runRollbackSh(b, ['--heal']);
    expect(r.code, r.out).toBe(0);
    expect(versionAt(b.platform)).toBe('3.4.1');
    expect(r.out).toMatch(/data was changed by a version newer than 3\.4\.1/);
    expect(whichDb(live())).toBe('newer');
  });
});
