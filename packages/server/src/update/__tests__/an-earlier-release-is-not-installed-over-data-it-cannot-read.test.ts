// The Update tab's installs ask the unpacked release whether it can read the data: an earlier release that
// lacks the data's last step is refused before anything is installed or the update record is touched; one
// that has it installs, and so does a forward update. Only GitHub's metadata (`fetch`), the download
// (`curl`, copying a zip built here), `npm` and the restart are stood in for.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../services/watchdog-refresh.js', () => ({ refreshBundledWatchdog: async () => ({ refreshed: false, reason: 'test' }) }));

import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { makeBox, makeTree, makeTreeWithSteps, treeHash, versionAt, type Box } from './safe-install-fixtures.js';

const home = process.env.DOJO_HOME as string;
const dojo = path.join(home, '.dojo');
const platform = path.join(dojo, 'platform');
const marker = path.join(dojo, 'update-state.json');
const savedPath = process.env.PATH;
let tools: Box;
/** Settles with the code of the restart an install hands to launchd (its timer fires a second after the reply). */
let restarted: Promise<unknown>;

/** The release GitHub offers: a whole tree of `version` with the given migration files. */
function release(version: string, steps: string[]): void {
  const work = path.join(tools.home, 'zipsrc');
  makeTreeWithSteps(path.join(work, 'dojo-platform', 'platform'), version, steps, { native: true });
  execFileSync('zip', ['-qr', path.join(tools.home, 'release.zip'), 'dojo-platform'], { cwd: work });
  fs.writeFileSync(path.join(tools.bin, 'curl'),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${path.join(tools.home, 'release.zip')}" "$2"; shift; fi; shift; done\n`, { mode: 0o755 });
  const digest = createHash('sha256').update(fs.readFileSync(path.join(tools.home, 'release.zip'))).digest('hex');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).endsWith('.sha256') ? `${digest}  dojo-platform.zip\n` : JSON.stringify({
    tag_name: `v${version}`, assets: [{ name: 'dojo-platform.zip', browser_download_url: 'https://example.invalid/dojo-platform.zip', size: 1000 },
      { name: 'dojo-platform.zip.sha256', browser_download_url: 'https://example.invalid/dojo-platform.zip.sha256', size: 90 }],
  }), { status: 200 })));
}

async function post(route: string, body: object): Promise<{ ok: boolean; error?: string }> {
  const { updateRouter } = await import('../../gateway/routes/update.js');
  const res = await updateRouter.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return await res.json() as { ok: boolean; error?: string };
}

beforeEach(() => {
  tools = makeBox('earlier-release-');
  process.env.PATH = `${tools.bin}:${savedPath ?? ''}`;
  restarted = new Promise((resolve) => { vi.spyOn(process, 'exit').mockImplementation(((code?: number) => resolve(code)) as never); });
  for (const n of fs.existsSync(dojo) ? fs.readdirSync(dojo) : []) {
    if (n.startsWith('platform') || n.startsWith('update-state')) fs.rmSync(path.join(dojo, n), { recursive: true, force: true });
  }
  makeTree(platform, '3.5.0', { native: true });
  freshDoneDb();
  doneDb().exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT); CREATE TABLE _migrations (name TEXT PRIMARY KEY); INSERT INTO _migrations VALUES ('209_a.sql'), ('210_b.sql')");
  fs.writeFileSync(marker, JSON.stringify({ phase: 'healthy', previousVersion: '3.4.1', dataBackup: '/d/dojo-pre.db', writeSeq: 7 }));
});

afterEach(() => {
  process.env.PATH = savedPath;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(tools.home, { recursive: true, force: true });
});

describe('an earlier release is not installed over data it cannot read', () => {
  it('refuses, sends him to Roll Back, and changes nothing on the box', async () => {
    release('3.4.1', ['209_a.sql']);
    const before = { tree: treeHash(platform), marker: fs.readFileSync(marker, 'utf-8') };
    const r = await post('/rollback', { tag: 'v3.4.1' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/3\.4\.1 cannot read your data: the last change made to it is one 3\.4\.1 does not have.*Roll Back in the menu bar/);
    expect(treeHash(platform)).toBe(before.tree);
    expect(fs.readFileSync(marker, 'utf-8')).toBe(before.marker);
  }, 120_000);

  it('an earlier release that has the data\'s last step installs', async () => {
    release('3.4.1', ['209_a.sql', '210_b.sql']);
    const r = await post('/rollback', { tag: 'v3.4.1' });
    expect(r.ok, r.error).toBe(true);
    expect(versionAt(platform)).toBe('3.4.1');
    expect(await restarted, 'the install restarts, inside this clause').toBe(0);
  }, 120_000);

  it('a forward update is not refused', async () => {
    release('3.6.0', ['209_a.sql', '210_b.sql', '211_c.sql']);
    const r = await post('/apply', {});
    expect(r.ok, r.error).toBe(true);
    expect(versionAt(platform)).toBe('3.6.0');
    expect(await restarted, 'the install restarts, inside this clause').toBe(0);
  }, 120_000);
});
