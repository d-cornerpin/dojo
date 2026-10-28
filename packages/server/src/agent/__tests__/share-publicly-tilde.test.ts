// ════════════════════════════════════════
// share_publicly publishes the path the guard approved
// ════════════════════════════════════════
//
// The share gate expands `~` itself and hands the caller the expanded `absPath`;
// every sibling publishes THAT path (`share_file` uses `shareGuard.absPath`).
// The share_publicly handler ran the guard, took its verdict, and then published
// the raw argument instead — so the one spelling its own guard accepted, `~/…`,
// passed the gate and was then rejected by createPublicShare's absoluteness
// check. The rule these cases hold: the path the guard approved is the path
// that gets published.
//
// TEST HYGIENE (same as share-guards.test.ts): `homeDir()` is redirected to a
// throwaway temp directory and the "secrets" inside it are dummy strings this
// file wrote.

import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Fixture world ──
const fixtureHome = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'share-tilde-home-'));

fs.mkdirSync(path.join(fixtureHome, '.dojo'), { recursive: true });
fs.mkdirSync(path.join(fixtureHome, '.ssh'), { recursive: true });
fs.writeFileSync(path.join(fixtureHome, '.dojo', 'secrets.yaml'), 'dummy: not-a-real-key\n');
fs.writeFileSync(path.join(fixtureHome, '.ssh', 'id_ed25519'), 'DUMMY PRIVATE KEY\n');

fs.mkdirSync(path.join(fixtureHome, 'site'), { recursive: true });
fs.writeFileSync(path.join(fixtureHome, 'site', 'index.html'), '<html><body>hi</body></html>');

// ── Module mocks ──
// auditLog / permission lookups hit the DB. The agent row returned here carries
// file_read '*', so a refusal in these tests can only have come from the guard,
// never from an incidental allowlist miss.
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({
      run: () => ({}),
      get: () => ({
        id: 'agent-under-test',
        name: 'Tester',
        permissions: '{"file_read":"*","file_write":"*"}',
        spawn_depth: 1,
        created_by: 'agent-parent',
        group_id: null,
      }),
      all: () => [],
    }),
    exec: () => ({}),
    transaction: (fn: () => unknown) => () => fn(),
  }),
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

vi.mock('../../services/tunnel.js', () => ({
  getTunnelStatus: () => ({ status: 'inactive', url: null }),
  killTunnelSync: () => { /* no-op */ },
}));

import { executeTool, toolResultOf } from '../tools/index.js';

const AGENT = 'agent-under-test';

// The guards resolve home through `homeDir()`, which reads DOJO_HOME.
process.env.DOJO_HOME = fixtureHome;

afterAll(() => {
  fs.rmSync(fixtureHome, { recursive: true, force: true });
});

describe('share_publicly publishes the path the guard approved', () => {
  it('accepts the ~/… spelling the guard itself expands', async () => {
    const r = toolResultOf(await executeTool(AGENT, {
      id: 'c1', name: 'share_publicly', arguments: { source_path: '~/site/index.html' },
    }));
    expect(r.content).toContain('Public URL');
    expect(r.content).not.toContain('must be absolute');
  });

  it('accepts the absolute spelling — unchanged behaviour', async () => {
    const r = toolResultOf(await executeTool(AGENT, {
      id: 'c2', name: 'share_publicly', arguments: { source_path: path.join(fixtureHome, 'site', 'index.html') },
    }));
    expect(r.content).toContain('Public URL');
  });

  it('still blocks ~/.dojo/secrets.yaml', async () => {
    const r = toolResultOf(await executeTool(AGENT, {
      id: 'c3', name: 'share_publicly', arguments: { source_path: '~/.dojo/secrets.yaml' },
    }));
    expect(r.content).toContain('[BLOCKED]');
    expect(r.content).not.toContain('Public URL');
  });

  it('a relative path still answers the absoluteness error', async () => {
    const r = toolResultOf(await executeTool(AGENT, {
      id: 'c4', name: 'share_publicly', arguments: { source_path: 'site/index.html' },
    }));
    expect(r.content).toContain('must be absolute');
    expect(r.content).not.toContain('Public URL');
  });
});
