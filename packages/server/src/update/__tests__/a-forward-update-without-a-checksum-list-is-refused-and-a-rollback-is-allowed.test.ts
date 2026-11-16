// A forward update whose release publishes no checksum list is refused before anything is downloaded; a
// rollback to a release from before the lists still installs. Only GitHub's metadata (`fetch`), the download
// (`curl`, copying a zip built here), `npm` and the restart are stood in for.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../services/watchdog-refresh.js', () => ({ refreshBundledWatchdog: async () => ({ refreshed: false, reason: 'test' }) }));

import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { makeBox, makeTree, makeTreeWithSteps, treeHash, versionAt, type Box } from './safe-install-fixtures.js';

const home = process.env.DOJO_HOME as string;
const platform = path.join(home, '.dojo', 'platform');
const savedPath = process.env.PATH;
let tools: Box;

/** GitHub offers `version` with no checksum list beside its zip; `curl` logs every download it is asked for. */
function releaseWithoutList(version: string): void {
  const work = path.join(tools.home, 'zipsrc');
  makeTreeWithSteps(path.join(work, 'dojo-platform', 'platform'), version, ['209_a.sql'], { native: true });
  execFileSync('zip', ['-qr', path.join(tools.home, 'release.zip'), 'dojo-platform'], { cwd: work });
  fs.writeFileSync(path.join(tools.bin, 'curl'),
    `#!/bin/sh\necho "$@" >> "${path.join(tools.home, 'curl.log')}"\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${path.join(tools.home, 'release.zip')}" "$2"; shift; fi; shift; done\n`, { mode: 0o755 });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    tag_name: `v${version}`, assets: [{ name: 'dojo-platform.zip', browser_download_url: 'https://example.invalid/dojo-platform.zip', size: 1000 }],
  }), { status: 200 })));
}

async function post(route: string, body: object): Promise<{ ok: boolean; error?: string }> {
  const { updateRouter } = await import('../../gateway/routes/update.js');
  const res = await updateRouter.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return await res.json() as { ok: boolean; error?: string };
}

beforeEach(() => {
  tools = makeBox('no-checksum-list-');
  process.env.PATH = `${tools.bin}:${savedPath ?? ''}`;
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  fs.rmSync(path.join(home, '.dojo'), { recursive: true, force: true });
  makeTree(platform, '3.5.0', { native: true });
  freshDoneDb();
  doneDb().exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT); CREATE TABLE _migrations (name TEXT PRIMARY KEY); INSERT INTO _migrations VALUES ('209_a.sql')");
});

afterEach(() => {
  process.env.PATH = savedPath;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(tools.home, { recursive: true, force: true });
});

describe('a release with no checksum list', () => {
  it('is refused as a forward update, before anything is downloaded', async () => {
    releaseWithoutList('3.6.0');
    const before = treeHash(platform);
    const r = await post('/apply', {});
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/checksum list/);
    expect(fs.existsSync(path.join(tools.home, 'curl.log'))).toBe(false);
    expect(treeHash(platform)).toBe(before);
  }, 120_000);

  it('still installs as a rollback', async () => {
    releaseWithoutList('3.4.1');
    const r = await post('/rollback', { tag: 'v3.4.1' });
    expect(r.ok, r.error).toBe(true);
    expect(versionAt(platform)).toBe('3.4.1');
  }, 120_000);
});
