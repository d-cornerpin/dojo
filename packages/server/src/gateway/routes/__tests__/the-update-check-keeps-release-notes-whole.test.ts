// The update check carries the release notes whole for the update screen; only the agent's
// check_for_update tool result cuts them, at 1,000 characters.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'update-notes-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const { updateRouter } = await import('../update.js');
const { platformHandlers } = await import('../../../agent/tools/cat/platform.js');

const BODY = `## Notes\n${'x'.repeat(2990)}\nEND`;

beforeAll(() => {
  migrations.runMigrations();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    tag_name: 'v999.0.0', name: 'Big', published_at: '2026-01-01T00:00:00Z', body: BODY, assets: [],
  }), { status: 200 })));
});

afterAll(() => {
  vi.unstubAllGlobals();
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the update check keeps release notes whole', () => {
  it('the check route returns every character; the agent tool result carries the first 1,000', async () => {
    const res = await updateRouter.request('/check');
    const json = await res.json() as { data: { releaseNotes: string } };
    expect(json.data.releaseNotes).toBe(BODY);

    const out = await platformHandlers.check_for_update({ agentId: 'a1', name: 'check_for_update', args: {}, callId: 'c', toolCall: {} as never });
    expect(out.content).toContain(BODY.slice(0, 1000));
    expect(out.content).not.toContain(BODY.slice(0, 1001));
  });
});
