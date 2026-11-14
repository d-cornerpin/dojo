// A main-agent call that could wreck the Mac or the Dojo is warned once; the identical call again is
// authorized. Nothing here runs a command: only the gate and the broker are asked.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const PRIMARY = 'primary-agent';
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === PRIMARY,
}));

const { runMigrations } = await import('../../../../../db/migrations.js');
const { runRefusalGates } = await import('../refusal-gates.js');
const { initState } = await import('../../../state.js');
const { authorizeExecShapedCall } = await import('../../../../brokers/exec-seam.js');
const { grantForManifest } = await import('../../../../brokers/grants.js');
const { PRIMARY_AGENT_PERMISSIONS } = await import('../../../../manifest.js');
const { authorizeFs } = await import('../../../../brokers/fs.js');
const { resolvePathArg } = await import('../../../../brokers/resolve.js');

const WRECKS = [
  { name: 'shell', arguments: { script: 'rm -rf ~' } },
  { name: 'shell', arguments: { script: 'sudo rm -rf /' } },
  { name: 'shell', arguments: { script: 'rm -rf ~/.dojo/data' } },
  { name: 'shell', arguments: { script: 'mv ~/.dojo/backups /tmp/old' } },
  { name: 'shell', arguments: { script: 'rm ~/.dojo/secrets.yaml' } },
  { name: 'shell', arguments: { script: 'echo x > ~/.dojo/secrets.yaml' } },
  { name: 'shell', arguments: { script: 'sqlite3 ~/.dojo/data/dojo.db "DELETE FROM messages"' } },
  { name: 'exec', arguments: { argv: ['truncate', '-s', '0', `${process.env.HOME}/.dojo/data/dojo.db`] } },
  { name: 'applescript_run', arguments: { script: 'do shell script "rm -rf ~"' } },
  { name: 'file_write', arguments: { path: '~/.dojo/data/dojo.db', content: 'x' } },
  { name: 'kill_agent', arguments: { agent_id: PRIMARY } },
  { name: 'kill_agent', arguments: { agent_id: 'Keeper' } },
];

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const seed = mockDb.current.prepare(`INSERT INTO agents (id, name, status, classification) VALUES (?, ?, 'idle', ?)`);
  seed.run(PRIMARY, 'Main', 'sensei');
  seed.run('keeper-agent', 'Keeper', 'sensei');
  seed.run('worker-agent', 'Worker', 'apprentice');
});

const gate = (agentId: string, call: { name: string; arguments: Record<string, unknown> }, seen: Set<string>) =>
  runRefusalGates(initState({ agentId, turnNumber: 1, lastUserMessageContent: null } as never) as never,
    { id: 'c', ...call } as never, { agentId, turnNumber: 1, turnCtx: {}, counterparty: null, refusedOnceSigs: seen } as never, false).refusal;

describe('a Dojo-wrecking call warns once, then runs', () => {
  it('the first attempt is a warning naming the loss; the identical repeat passes the gate', () => {
    for (const call of WRECKS) {
      const seen = new Set<string>();
      expect(gate(PRIMARY, call, seen)?.content, call.name).toMatch(/^\[Engine warning, nothing ran\] This call would .+ repeat the exact same call in this same turn and it will run\.$/);
      expect(gate(PRIMARY, call, seen), JSON.stringify(call)).toBeNull();
    }
  });

  it('ordinary work and copies out are not warned', () => {
    for (const script of ['ls ~/.dojo/data', 'chmod 600 ~/.dojo/secrets.yaml', 'cp ~/.dojo/data/dojo.db ~/Desktop/', 'rm -rf ~/Downloads/tmp', 'chmod 777 ~/Shared']) {
      expect(gate(PRIMARY, { name: 'shell', arguments: { script } }, new Set()), script).toBeNull();
    }
    expect(gate(PRIMARY, { name: 'kill_agent', arguments: { agent_id: 'Worker' } }, new Set())).toBeNull();
  });

  it('past the warning, the broker authorizes the call', () => {
    const main = grantForManifest(PRIMARY, PRIMARY_AGENT_PERMISSIONS);
    for (const line of ['rm -rf ~', 'sudo rm -rf /', 'rm -rf ~/.dojo/data', 'mv ~/.dojo/backups /tmp/old', 'rm ~/.dojo/secrets.yaml']) {
      expect(authorizeExecShapedCall(main, 'shell', line).allowed, line).toBe(true);
    }
    const db = resolvePathArg('~/.dojo/data/dojo.db');
    expect(db.ok && authorizeFs(main, 'fs_write', db.value).allowed).toBe(true);
  });

  it('another agent is not warned (its broker refuses outright)', () => {
    expect(gate('helper-agent', WRECKS[0], new Set())).toBeNull();
  });
});
