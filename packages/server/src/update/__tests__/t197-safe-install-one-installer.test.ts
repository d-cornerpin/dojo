// ════════════════════════════════════════════════════════════════════════════════════════
// t197 (v3.4 F2) — THE OLD MECHANISM IS GONE, AND THE REPAIRS EXIST WHERE THEY MUST.
//
// A census, not a sentence: at e63aa3d7 the in-place copy over the live tree lived in THREE
// places (applyUpdate, the rollback route, deploy/install.sh), plus a `cp -R` backup in two.
// Two copies of one dangerous sequence drift; the fix is one installer that every door calls.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, makeBox, makeTree, runRollbackSh, versionAt, type Box } from './t197-safe-install-fixtures.js';

const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
/** Code only: comment lines carry the history of the retired shape by name. */
const code = (rel: string): string => read(rel).split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join('\n');

describe('census: nothing copies a tree over the live platform any more', () => {
  it('the update route has no in-place copy and no cp -R backup', () => {
    const src = code('packages/server/src/gateway/routes/update.ts');
    expect(src, 'rsync over the live tree').not.toMatch(/rsync -a --delete/);
    expect(src, 'a whole-tree cp -R backup').not.toMatch(/cp -R "\$\{PLATFORM_DIR\}"/);
    expect(src, 'npm install run in the live tree').not.toMatch(/cwd:\s*PLATFORM_DIR/);
    // Apply and rollback both go through the one installer.
    expect((src.match(/installPlatformTree\(/g) ?? []).length).toBe(1);
  });

  it('the installer script does not rsync into the live platform, and calls the same installer', () => {
    const sh = code('deploy/install.sh');
    expect(sh).not.toMatch(/rsync[^\n]*"\$PLATFORM_DIR\/?"/);
    expect(sh, 'a fresh box must not be handed an empty platform folder').not.toMatch(/mkdir -p "\$PLATFORM_DIR"/);
    expect(sh).toMatch(/install-tree-cli\.js/);
  });

  it('exactly one npm install leg exists in the update path', () => {
    const files = ['packages/server/src/gateway/routes/update.ts', 'packages/server/src/update/install-tree.ts'];
    const legs = files.flatMap((f) => code(f).match(/'npm install --omit=dev'/g) ?? []);
    expect(legs.length).toBe(1);
  });
});

describe('the watchdog repairs a missing platform folder and tells the owner', () => {
  it('runCheck repairs before it judges health, and spawns the repair with --heal', () => {
    const idx = code('watchdog/src/index.ts');
    const heal = idx.indexOf('decideSwapHeal(');
    const health = idx.indexOf('await checkPlatformHealth()');
    expect(heal).toBeGreaterThan(-1);
    expect(heal, 'the repair is decided before the health check').toBeLessThan(health);
    expect(idx).toMatch(/spawnRollbackDetached\([^)]*\['--heal'\]/);
  });

  it('decides what it will say from the facts on disk', async () => {
    const box = makeBox('t197-wd-');
    try {
      const { decideSwapHeal } = await import('../../../../../watchdog/src/swap-heal.js');
      makeTree(box.platform, '3.3.3');
      expect(decideSwapHeal(box.dojo, null).action).toBe('none');

      fs.renameSync(box.platform, path.join(box.dojo, 'platform.backup-3.3.3'));
      const staged = makeTree(path.join(box.dojo, 'platform.staging-1-1', 'platform'), '3.4.0');
      const pending = { phase: 'pending-update', targetVersion: '3.4.0', previousVersion: '3.3.3',
        backupDir: path.join(box.dojo, 'platform.backup-3.3.3'), stagingDir: staged } as never;
      const fwd = decideSwapHeal(box.dojo, pending);
      expect(fwd).toMatchObject({ action: 'heal', finishes: 'update' });
      expect((fwd as { text: string }).text).toMatch(/3\.4\.0/);
      expect((fwd as { text: string }).text).toMatch(/data was not touched/i);

      fs.rmSync(staged, { recursive: true });
      const back = decideSwapHeal(box.dojo, pending);
      expect(back).toMatchObject({ action: 'heal', finishes: 'restore' });
      expect((back as { text: string }).text).toMatch(/3\.3\.3/);

      fs.rmSync(path.join(box.dojo, 'platform.backup-3.3.3'), { recursive: true });
      const none = decideSwapHeal(box.dojo, pending);
      expect(none).toMatchObject({ action: 'heal', finishes: 'nothing-to-restore' });
      expect((none as { text: string }).text).toMatch(/installer/i);
    } finally { fs.rmSync(box.home, { recursive: true, force: true }); }
  });

  it('waits while a LIVE installer holds the swap lock, and repairs once its holder is dead', async () => {
    const box = makeBox('t197-wd-lock-');
    try {
      const { decideSwapHeal } = await import('../../../../../watchdog/src/swap-heal.js');
      makeTree(path.join(box.dojo, 'platform.backup-3.3.3'), '3.3.3');
      const lock = path.join(box.dojo, 'rollback.lock');
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      expect(decideSwapHeal(box.dojo, null).action).toBe('wait');
      fs.writeFileSync(path.join(lock, 'pid'), '999999');
      expect(decideSwapHeal(box.dojo, null).action).toBe('heal');
    } finally { fs.rmSync(box.home, { recursive: true, force: true }); }
  });

  it('an interrupted update is told to the owner once, then the record goes quiet', () => {
    const idx = code('watchdog/src/index.ts');
    expect(idx).toMatch(/'interrupted'/);
    expect(idx).toMatch(/interruptedUpdateText\(/);
  });
});

describe('rollback.sh: the swap lock knows when its holder is dead', () => {
  let box: Box;
  afterEach(() => { fs.rmSync(box.home, { recursive: true, force: true }); });

  it('a lock left by a killed process does not block recovery for ever', () => {
    box = makeBox('t197-lock-');
    makeTree(box.platform, '3.4.0');
    makeTree(path.join(box.dojo, 'platform.backup-3.3.3'), '3.3.3');
    fs.mkdirSync(path.join(box.dojo, 'rollback.lock'));
    fs.writeFileSync(path.join(box.dojo, 'rollback.lock', 'pid'), '999999');
    const r = runRollbackSh(box);
    expect(r.code, r.out).toBe(0);
    expect(versionAt(box.platform)).toBe('3.3.3');
    expect(fs.existsSync(path.join(box.dojo, 'rollback.lock')), 'released on exit').toBe(false);
  });

  it('a lock held by a LIVE process is respected', () => {
    box = makeBox('t197-lock-live-');
    makeTree(box.platform, '3.4.0');
    makeTree(path.join(box.dojo, 'platform.backup-3.3.3'), '3.3.3');
    fs.mkdirSync(path.join(box.dojo, 'rollback.lock'));
    fs.writeFileSync(path.join(box.dojo, 'rollback.lock', 'pid'), String(process.pid));
    const r = runRollbackSh(box);
    expect(r.code).not.toBe(0);
    expect(versionAt(box.platform)).toBe('3.4.0');
    expect(fs.existsSync(path.join(box.dojo, 'rollback.lock')), 'not ours to remove').toBe(true);
  });

  it('--heal on a box whose platform is in place does nothing', () => {
    box = makeBox('t197-heal-noop-');
    makeTree(box.platform, '3.4.0');
    makeTree(path.join(box.dojo, 'platform.backup-3.3.3'), '3.3.3');
    expect(runRollbackSh(box, ['--heal']).code).toBe(0);
    expect(versionAt(box.platform)).toBe('3.4.0');
    expect(fs.existsSync(path.join(box.home, 'launchctl.log')), 'launchd untouched').toBe(false);
  });

  it('--heal finishes an interrupted rollback.sh (cut off between ITS two moves)', () => {
    box = makeBox('t197-heal-rb-');
    // rollback.sh moved the failed build aside and died before moving the backup in.
    makeTree(path.join(box.dojo, 'platform.failed-3.4.0-20261017-120000'), '3.4.0');
    const bk = makeTree(path.join(box.dojo, 'platform.backup-3.3.3'), '3.3.3');
    fs.writeFileSync(path.join(box.dojo, 'update-state.json'),
      JSON.stringify({ phase: 'rolled-back', backupDir: bk, targetVersion: '3.4.0', previousVersion: '3.3.3' }));
    const r = runRollbackSh(box, ['--heal']);
    expect(r.code, r.out).toBe(0);
    expect(versionAt(box.platform)).toBe('3.3.3');
  });
});

describe('the bundled watchdog refresh swaps its code whole, and heals the gap', () => {
  it('a missing dist with a complete next copy beside it is put back', async () => {
    const box = makeBox('t197-wdr-');
    try {
      const { healWatchdogDistSwap } = await import('../../services/watchdog-refresh.js');
      const installed = path.join(box.dojo, 'watchdog');
      fs.mkdirSync(path.join(installed, 'dist.next'), { recursive: true });
      fs.writeFileSync(path.join(installed, 'dist.next', 'index.js'), '// next');
      expect(healWatchdogDistSwap(installed)).toBe('restored-next');
      expect(fs.readFileSync(path.join(installed, 'dist', 'index.js'), 'utf8')).toBe('// next');
      expect(healWatchdogDistSwap(installed)).toBe('none');
    } finally { fs.rmSync(box.home, { recursive: true, force: true }); }
  });

  it('the refresh no longer rsyncs over the running watchdog code', () => {
    expect(code('packages/server/src/services/watchdog-refresh.ts')).not.toMatch(/rsync -a --delete/);
  });
});
