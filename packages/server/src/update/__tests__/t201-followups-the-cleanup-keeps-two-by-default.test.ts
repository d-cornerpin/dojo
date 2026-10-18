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
