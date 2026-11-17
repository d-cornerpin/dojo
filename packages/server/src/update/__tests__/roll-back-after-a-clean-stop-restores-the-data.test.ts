// rollback.sh, run for real in a scratch HOME: the live database is in WAL mode, as the product keeps it.
// Stopped cleanly it has no side files; crashed it keeps them. Either way, data ahead of the restored build
// goes back to the pre-update copy, and a level that cannot be read is treated as ahead.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeBox, makeTreeWithSteps, levelDb, whichDb, runRollbackSh, versionAt, type Box } from './safe-install-fixtures.js';

let b: Box;
const live = (): string => path.join(b.dojo, 'data', 'dojo.db');
const setAside = (): string[] => fs.readdirSync(path.join(b.dojo, 'data', 'backups'))
  .filter((f) => f.startsWith('dojo-replaced-') && f.endsWith('.db'))
  .map((f) => whichDb(path.join(b.dojo, 'data', 'backups', f)));
const result = (): string => fs.readFileSync(path.join(b.dojo, 'rollback-result'), 'utf-8');

afterEach(() => { fs.rmSync(b.home, { recursive: true, force: true }); });

function box(o: { applied: string[] | null; crashed?: boolean; copy?: boolean }): void {
  b = makeBox('rollback-wal-');
  makeTreeWithSteps(b.platform, '3.5.0', ['209_a.sql', '210_b.sql']);
  const backupDir = makeTreeWithSteps(path.join(b.dojo, 'platform.backup-3.4.1'), '3.4.1', ['209_a.sql']);
  levelDb(live(), o.applied, 'newer', { crashed: o.crashed });
  const dataBackup = o.copy === false ? null
    : levelDb(path.join(b.dojo, 'data', 'backups', 'dojo-pre-1-of-2-2026-11-16T10-00-00.db'), ['209_a.sql'], 'before');
  fs.writeFileSync(path.join(b.dojo, 'update-state.json'), JSON.stringify({
    phase: 'rolled-back', targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir, dataBackup,
    migrationsRanDuringEpisode: true, rollbackCount: 1, writeSeq: 4,
  }));
}

function expectRestoredWithData(): void {
  const r = runRollbackSh(b, ['--auto']);
  expect(r.code, r.out).toBe(0);
  expect(versionAt(b.platform)).toBe('3.4.1');
  expect(whichDb(live())).toBe('before');
  expect(setAside()).toEqual(['newer']);
  expect(result()).toMatch(/^restored-with-data\t.*together with your data/);
}

describe('roll back after a clean stop restores the data', () => {
  it('the Dojo was stopped cleanly (no side files), then Roll Back: the data goes back too', () => {
    box({ applied: ['209_a.sql', '210_b.sql'] });
    expect(fs.existsSync(`${live()}-wal`)).toBe(false);
    expectRestoredWithData();
  });

  it('the Dojo crashed (side files present), then Roll Back: the data goes back too', () => {
    box({ applied: ['209_a.sql', '210_b.sql'], crashed: true });
    expect(fs.existsSync(`${live()}-wal`)).toBe(true);
    expectRestoredWithData();
  });

  it('the level cannot be read: the safe path, the pre-update copy goes back and the newer data is kept', () => {
    box({ applied: null });
    expectRestoredWithData();
  });

  it('the level cannot be read and there is no copy: nothing changes, and the sentence says why', () => {
    box({ applied: null, copy: false });
    expect(runRollbackSh(b, ['--auto']).code).toBe(1);
    expect(versionAt(b.platform)).toBe('3.5.0');
    expect(whichDb(live())).toBe('newer');
    expect(result()).toMatch(/^unchanged\t.*your data could not be read and there is no copy of it from before the update\. Nothing was changed/);
  });
});
