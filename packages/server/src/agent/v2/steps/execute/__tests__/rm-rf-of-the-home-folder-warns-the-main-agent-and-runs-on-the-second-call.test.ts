// The main agent's rm of `/`, its home folder or a folder above it is warned once, and the identical
// repeat passes the gate and the broker. Decisions only: nothing is deleted.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';

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
const { homeDir } = await import('../../../../../home.js');

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});

const gate = (script: string, seen: Set<string>) =>
  runRefusalGates(initState({ agentId: PRIMARY, turnNumber: 1, lastUserMessageContent: null } as never) as never,
    { id: 'c', name: 'shell', arguments: { script } } as never, { agentId: PRIMARY, turnNumber: 1, turnCtx: {}, counterparty: null, refusedOnceSigs: seen } as never, false).refusal;

describe('rm -rf of the home folder warns the main agent and runs on the second call', () => {
  it.each(['rm -rf ~', 'rm -rf ~/', 'rm -r -f "$HOME_UNUSED" ~', `rm -rf ${homeDir()}`, `rm -rf ${path.dirname(homeDir())}`, 'sudo rm -rf /', 'cd /tmp; rm -rf /'])('%s', (script) => {
    const seen = new Set<string>();
    expect(gate(script, seen)?.content).toMatch(/^\[Engine warning, nothing ran\] This call would erase the whole disk or the home folder/);
    expect(gate(script, seen)).toBeNull();
    expect(authorizeExecShapedCall(grantForManifest(PRIMARY, PRIMARY_AGENT_PERMISSIONS), 'shell', script).allowed).toBe(true);
  });

  it('a folder inside the home is not warned', () => {
    for (const script of ['rm -rf ~/Downloads/tmp', 'rm -rf ./build', 'grep -r "rm -rf ~" notes.txt']) expect(gate(script, new Set()), script).toBeNull();
  });
});
