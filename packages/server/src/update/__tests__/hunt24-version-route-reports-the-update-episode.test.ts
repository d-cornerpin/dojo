// The version route tells a waiting page how the current update/rollback episode stands, so the page
// can say a failed update failed instead of spinning. Idle or no marker reads as no episode.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { updateRouter } from '../../gateway/routes/update.js';
import { UPDATE_STATE_PATH, emptyMarker } from '../../update-state.js';

const get = async () => (await updateRouter.request('/version')).json() as Promise<{ ok: boolean; data: { version: string; episode: null | { phase: string; targetVersion: string | null; failedReason: string | null } } }>;

afterEach(() => { fs.rmSync(UPDATE_STATE_PATH, { force: true }); });

describe('GET /update/version episode', () => {
  it('is null when there is no marker', async () => {
    fs.rmSync(UPDATE_STATE_PATH, { force: true });
    const r = await get();
    expect(r.ok).toBe(true);
    expect(r.data.episode).toBeNull();
  });
  it('reports a rolled-back episode with its target version', async () => {
    fs.mkdirSync(path.dirname(UPDATE_STATE_PATH), { recursive: true });
    fs.writeFileSync(UPDATE_STATE_PATH, JSON.stringify({ ...emptyMarker(), phase: 'rolled-back', targetVersion: '9.9.9', previousVersion: '9.9.8' }));
    const r = await get();
    expect(r.data.episode).toMatchObject({ phase: 'rolled-back', targetVersion: '9.9.9' });
  });
});
