// ════════════════════════════════════════════════════════════════════════════════════════
// t201 follow-up (owner decision 21: keep TWO update backups) — THE SERVER'S CLEAN-UP DEFAULT.
//
// `POST /update/backups/cleanup` takes `keep` in the body and, when the body omits it, used to
// fall back to ONE: a caller that did not say (an old dashboard, a script) threw away the second
// rollback target. The fallback is the same number the automatic prune and the listing's
// `keepDefault` use: two.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let home = '';
const makeBackups = (...versions: string[]): void => {
  for (const v of versions) fs.mkdirSync(path.join(home, '.dojo', `platform.backup-${v}`), { recursive: true });
};
const post = async (body?: unknown) => {
  const { updateRouter } = await import('../../gateway/routes/update.js');
  const res = await updateRouter.request('/backups/cleanup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json() as Promise<{ ok: boolean; data: { status: string; kept: number; targetCount?: number } }>;
};
const settle = async (): Promise<void> => {
  const { updateRouter } = await import('../../gateway/routes/update.js');
  for (let i = 0; i < 100; i++) {
    const s = await (await updateRouter.request('/backups/cleanup/status')).json() as { data: { inProgress: boolean } };
    if (!s.data.inProgress) return;
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 't201-cleanup-'));
  fs.mkdirSync(path.join(home, '.dojo'), { recursive: true });
  vi.stubEnv('DOJO_HOME', home);
  vi.resetModules();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

describe('a clean-up that does not say how many to keep keeps two', () => {
  it('two backups on disk, no `keep` in the body: nothing to delete, and it says it kept two', async () => {
    makeBackups('3.3.1', '3.3.2');
    const r = await post({});
    expect(r.data.status).toBe('noop');
    expect(r.data.kept).toBe(2);
    expect(fs.readdirSync(path.join(home, '.dojo')).sort()).toEqual(['platform.backup-3.3.1', 'platform.backup-3.3.2']);
  });

  it('three backups, no body at all: exactly the oldest one goes, the newest two stay', async () => {
    makeBackups('3.3.0', '3.3.1', '3.3.2');
    const r = await post();
    expect(r.data.status).toBe('started');
    expect(r.data.targetCount).toBe(1);
    await settle();
    expect(fs.readdirSync(path.join(home, '.dojo')).sort()).toEqual(['platform.backup-3.3.1', 'platform.backup-3.3.2']);
  });

  it('CONTROL: an explicit `keep` is still honoured', async () => {
    makeBackups('3.3.1', '3.3.2');
    const r = await post({ keep: 1 });
    expect(r.data.status).toBe('started');
    await settle();
    expect(fs.readdirSync(path.join(home, '.dojo'))).toEqual(['platform.backup-3.3.2']);
  });
});

describe('t286: a clean-up never deletes the copy a rollback would restore', () => {
  const postRaw = async (body: unknown) => {
    const { updateRouter } = await import('../../gateway/routes/update.js');
    return updateRouter.request('/backups/cleanup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };
  it('keep=0 is refused with the error shape and nothing is deleted', async () => {
    makeBackups('3.3.1', '3.3.2');
    const res = await postRaw({ keep: 0 });
    expect(res.status).toBe(400);
    const j = await res.json() as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/newest rollback copy is always kept/);
    expect(fs.readdirSync(path.join(home, '.dojo')).sort()).toEqual(['platform.backup-3.3.1', 'platform.backup-3.3.2']);
  });
  it('the copy the update marker recorded (what rollback.sh restores first) survives even when older than keep allows', async () => {
    makeBackups('3.3.0', '3.3.1', '3.3.2');
    const recorded = path.join(home, '.dojo', 'platform.backup-3.3.0');
    fs.writeFileSync(path.join(recorded, 'package.json'), '{"version":"3.3.0"}');
    fs.writeFileSync(path.join(home, '.dojo', 'update-state.json'), JSON.stringify({ phase: 'failed-permanently', backupDir: recorded }));
    await postRaw({ keep: 1 });
    await settle();
    expect(fs.existsSync(recorded)).toBe(true);
    expect(fs.existsSync(path.join(home, '.dojo', 'platform.backup-3.3.1'))).toBe(false);
  });
});

// Review FIX 5: ONE rule picks the copy a rollback restores. The clean-up asks rollback.sh itself
// (its --print-target mode), so stable releases outrank pre-releases here exactly as they do there.
describe('t286: the protected copy is the one rollback.sh itself would pick', () => {
  const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/scripts/rollback.sh');
  const installScript = (): void => {
    fs.mkdirSync(path.join(home, '.dojo', 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(home, '.dojo', 'scripts', 'rollback.sh'));
  };
  const clean = async (keep: number): Promise<void> => {
    const { updateRouter } = await import('../../gateway/routes/update.js');
    await updateRouter.request('/backups/cleanup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keep }) });
    await settle();
  };
  it('a stable copy outranks a newer pre-release: with keep=1 the stable one survives', async () => {
    installScript();
    makeBackups('3.1.16', '3.1.17-preflight.20');
    await clean(1);
    expect(fs.existsSync(path.join(home, '.dojo', 'platform.backup-3.1.16'))).toBe(true);
  });
  it('the script is run in its read-only mode: no lock, no services, no moves', async () => {
    installScript();
    makeBackups('3.1.16', '3.1.17-preflight.20');
    await clean(1);
    expect(fs.existsSync(path.join(home, '.dojo', 'rollback.lock'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.dojo', 'platform'))).toBe(false);
  });
  it('an installed rollback.sh that predates --print-target is never run (it would roll back): both candidates are kept', async () => {
    fs.mkdirSync(path.join(home, '.dojo', 'scripts'), { recursive: true });
    const marker = path.join(home, 'old-script-ran');
    fs.writeFileSync(path.join(home, '.dojo', 'scripts', 'rollback.sh'), `#!/bin/bash\ntouch "${marker}"\n`, { mode: 0o755 });
    makeBackups('3.1.16', '3.1.17-preflight.20', '3.1.15');
    await clean(1);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(home, '.dojo', 'platform.backup-3.1.16'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.dojo', 'platform.backup-3.1.17-preflight.20'))).toBe(true);
  });
});

