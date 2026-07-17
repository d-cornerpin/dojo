// ════════════════════════════════════════
// Peer-status cache relocation (2026-07-16 finding, DOJO-ISSUES-LOG)
//
// Pins the invariant that fixed the roster cache-breaker:
//   1. sys.group (cached prefix) renders member NAMES only, never live status;
//   2. msg.peer-status (volatile lane) renders the live statuses, is registered
//      between TurnContext and CurrentTime, and returns null with no peers.
// A regression that puts "(working)" back in the roster fails test 1; a
// registration typo that drops the live line fails test 2.
// ════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { assembleGroupContext, renderPeerStatusLine } from '../../agent/groups.js';
// Side-effect import: entries self-register at module load; without this the
// registry is empty in an isolated test process and every lookup fails.
import '../registry/entries.js';
import { getMessageEntries } from '../registry/registry.js';
import { MessageSlot } from '../registry/types.js';

function seedGroupBox(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, group_id TEXT, updated_at TEXT);
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT, description TEXT);
  `);
  db.prepare("INSERT INTO agent_groups VALUES ('g1', 'System', 'the household system group')").run();
  db.prepare("INSERT INTO agents VALUES ('primary-1', 'Primary', 'working', 'g1', '')").run();
  db.prepare("INSERT INTO agents VALUES ('peer-a', 'Curator', 'working', 'g1', '')").run();
  db.prepare("INSERT INTO agents VALUES ('peer-b', 'Mender', 'idle', 'g1', '')").run();
  db.prepare("INSERT INTO agents VALUES ('gone', 'Old', 'terminated', 'g1', '')").run();
  return db;
}

describe('sys.group roster is cache-stable', () => {
  it('renders member names WITHOUT live status', () => {
    mockDb.current = seedGroupBox();
    const roster = assembleGroupContext('primary-1');
    expect(roster).toContain('- Curator');
    expect(roster).toContain('- Mender');
    expect(roster).not.toContain('(working)');
    expect(roster).not.toContain('(idle)');
    expect(roster).not.toContain('Old');
  });

  it('renders byte-identically across a peer status flip', () => {
    mockDb.current = seedGroupBox();
    const before = assembleGroupContext('primary-1');
    mockDb.current.prepare("UPDATE agents SET status='idle' WHERE id='peer-a'").run();
    const after = assembleGroupContext('primary-1');
    expect(after).toBe(before);
  });
});

describe('msg.peer-status carries the live statuses in the volatile lane', () => {
  it('renders the live line and tracks a flip', () => {
    mockDb.current = seedGroupBox();
    expect(renderPeerStatusLine('primary-1')).toBe('[Peer status: Curator working, Mender idle]');
    mockDb.current.prepare("UPDATE agents SET status='idle' WHERE id='peer-a'").run();
    expect(renderPeerStatusLine('primary-1')).toBe('[Peer status: Curator idle, Mender idle]');
  });

  it('is registered in the PeerStatus slot between TurnContext and CurrentTime', () => {
    const entry = getMessageEntries().find((e) => e.id === 'msg.peer-status');
    expect(entry).toBeTruthy();
    expect(entry!.slot).toBe(MessageSlot.PeerStatus);
    expect(MessageSlot.PeerStatus).toBeGreaterThan(MessageSlot.TurnContext);
    expect(MessageSlot.PeerStatus).toBeLessThan(MessageSlot.CurrentTime);
  });

  it('renders null for an agent with no group peers', () => {
    mockDb.current = seedGroupBox();
    mockDb.current.prepare("UPDATE agents SET group_id=NULL WHERE id='primary-1'").run();
    const entry = getMessageEntries().find((e) => e.id === 'msg.peer-status')!;
    const out = entry.render({ agentId: 'primary-1' } as never);
    expect(out).toBeNull();
  });

  it('the registry entry renders the same content the helper produces', () => {
    mockDb.current = seedGroupBox();
    const entry = getMessageEntries().find((e) => e.id === 'msg.peer-status')!;
    const out = entry.render({ agentId: 'primary-1' } as never);
    expect(out).toEqual({ role: 'user', content: '[Peer status: Curator working, Mender idle]' });
  });
});
