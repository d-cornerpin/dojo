// The Update tab's rollback to an earlier release refuses, before anything is installed or the update record
// is touched, when the data's last step is one that release does not have. Only GitHub's metadata (`fetch`)
// and the download (`curl`, copying a zip built here) are stood in for.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());

import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { makeTree, makeTreeWithSteps, treeHash } from './safe-install-fixtures.js';

const home = process.env.DOJO_HOME as string;
const dojo = path.join(home, '.dojo');
const platform = path.join(dojo, 'platform');
const marker = path.join(dojo, 'update-state.json');
const work = path.join(home, 'earlier-release');
const savedPath = process.env.PATH;

beforeEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(platform, { recursive: true, force: true });
  makeTree(platform, '3.5.0');
  makeTreeWithSteps(path.join(work, 'zipsrc', 'dojo-platform', 'platform'), '3.4.1', ['209_a.sql']);
  execFileSync('zip', ['-qr', path.join(work, 'release.zip'), 'dojo-platform'], { cwd: path.join(work, 'zipsrc') });
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${path.join(work, 'release.zip')}" "$2"; shift; fi; shift; done\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${savedPath ?? ''}`;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    tag_name: 'v3.4.1', assets: [{ name: 'dojo-platform.zip', browser_download_url: 'https://example.invalid/dojo-platform.zip', size: 1000 }],
  }), { status: 200 })));
  freshDoneDb();
  doneDb().exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY); INSERT INTO _migrations VALUES ('209_a.sql'), ('210_b.sql')");
  fs.writeFileSync(marker, JSON.stringify({ phase: 'healthy', previousVersion: '3.4.1', dataBackup: '/d/dojo-pre.db', writeSeq: 7 }));
});

afterEach(() => {
  process.env.PATH = savedPath;
  vi.unstubAllGlobals();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(marker, { force: true });
});

describe('an earlier release is not installed over data it cannot read', () => {
  it('refuses, sends him to Roll Back, and changes nothing on the box', async () => {
    const before = { tree: treeHash(platform), marker: fs.readFileSync(marker, 'utf-8') };
    const { updateRouter } = await import('../../gateway/routes/update.js');
    const res = await updateRouter.request('/rollback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: 'v3.4.1' }),
    });
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/3\.4\.1 cannot read your data.*Roll Back in the menu bar/);
    expect(treeHash(platform)).toBe(before.tree);
    expect(fs.readFileSync(marker, 'utf-8')).toBe(before.marker);
  }, 120_000);
});
