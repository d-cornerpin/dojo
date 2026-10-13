// ════════════════════════════════════════════════════════════════════════════════════════
// t146 — ONE ANSWER TO "WHO IS THE OWNER ON IMESSAGE".
//
// At `4cb9ed61` three functions answered it, each its own way:
//   · the bridge's `getDefaultSender` — where every owner notice goes. It reads the safe-sender
//     records through `parseSafeSenders`, which GUARANTEES one starred record (none starred →
//     the record matching the legacy key, else the first; a legacy bare-string list → its first);
//   · the refusal gate's `recipientIsChannelOwner` — the same parse, but never the legacy key;
//   · the told record's `ownerAddresses` (t142) — its own parse, forced by an import cycle: only
//     an object explicitly marked `is_primary: true` counted, so a list with nobody starred, or
//     a legacy bare-string list, had NO owner — while the bridge was texting one.
//
// So on such a box the platform's own notice to the owner was refused by the told record as
// "not the owner", and the owner was told about the same blocked task again. The witnesses
// below take the owner-notice door's shape (a platform outbound to the address the bridge
// itself picks, through the real outbound scope) and ask the record whether that was the owner.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t146-owner', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not under test */ }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: () => Promise.resolve() }) }));

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

import { runMigrations } from '../../db/migrations.js';
import { recordPersonTold } from '../validation-drive.js';
import { getDefaultSender } from '../../services/imessage-bridge.js';
import { withOutbound, recordAtDoor, currentOutboundDeliveryId, PLATFORM_SENDER } from '../../agent/v2/outbound.js';

/** Fictional throughout (G1). */
const FIRST = '+15550111';
const SECOND = '+15550122';
const T = 1_700_000_000_000;

const db = (): Database.Database => mockDb.current!;

function setConfig(key: string, value: string): void {
  db().prepare(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(key, value);
}

function seedWork(id: string): void {
  db().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state, intent,
                       wakes, closes_thread, hop_count, compile_pending, attempts,
                       title, priority, opened_at, updated_at, provenance)
     VALUES (?, 'task', 'quillon', 'owner', 'owner', 'tracker', ?, 'blocked', 'do-it',
             1, 0, 0, 0, 0,
             'flash the greenhouse controller', 'normal', ?, ?, 'live')`,
  ).run(id, id, T, T);
}

/** The owner-notice door's shape: a platform outbound to the address the BRIDGE picks for the
 *  owner, through the real outbound scope, then the record asked about that delivery. */
function noticeToTheBridgesOwner(workId: string): { sentTo: string | null; told: ReturnType<typeof recordPersonTold> | null } {
  const owner = getDefaultSender();
  if (!owner) return { sentTo: null, told: null };
  return withOutbound(
    { agentId: PLATFORM_SENDER, tool: 'alert', channel: 'imessage', recipientId: owner },
    () => {
      recordAtDoor({ outcome: 'delivered', channel: 'imessage' });
      return { sentTo: owner, told: recordPersonTold(workId, { deliveryId: currentOutboundDeliveryId()!, via: 'owner_notice' }) };
    },
  );
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO agents (id, name, status) VALUES ('quillon', 'Quillon', 'idle')`).run();
  seedWork('t-1');
});

describe('the owner the bridge texts is the owner the told record recognises', () => {
  it.fails('RED at 4cb9ed61: a list with nobody starred — the bridge texts the first record, the record refuses it', () => {
    setConfig('imessage_approved_senders', JSON.stringify([
      { address: FIRST, name: 'First' }, { address: SECOND, name: 'Second' },
    ]));
    const { sentTo, told } = noticeToTheBridgesOwner('t-1');
    expect(sentTo, 'the bridge picks the first record as the owner').toBe(FIRST);
    expect(told?.kind, JSON.stringify(told)).toBe('applied');
  });

  it('control (agreed at 4cb9ed61 too): nobody starred and the legacy key names the SECOND record — that record is the owner', () => {
    setConfig('imessage_approved_senders', JSON.stringify([
      { address: FIRST, name: 'First' }, { address: SECOND, name: 'Second' },
    ]));
    setConfig('imessage_default_sender', SECOND);
    const { sentTo, told } = noticeToTheBridgesOwner('t-1');
    expect(sentTo).toBe(SECOND);
    expect(told?.kind, JSON.stringify(told)).toBe('applied');
  });

  it.fails('RED at 4cb9ed61: a legacy bare-string list — its first entry is the owner', () => {
    setConfig('imessage_approved_senders', JSON.stringify([FIRST, SECOND]));
    const { sentTo, told } = noticeToTheBridgesOwner('t-1');
    expect(sentTo).toBe(FIRST);
    expect(told?.kind, JSON.stringify(told)).toBe('applied');
  });

  it('control: a starred record is the owner, and the other record is not', () => {
    setConfig('imessage_approved_senders', JSON.stringify([
      { address: FIRST, name: 'First' }, { address: SECOND, name: 'Second', is_primary: true },
    ]));
    setConfig('imessage_default_sender', FIRST); // stale legacy key: a starred record outranks it
    const { sentTo, told } = noticeToTheBridgesOwner('t-1');
    expect(sentTo).toBe(SECOND);
    expect(told?.kind).toBe('applied');
    const toFirst = withOutbound(
      { agentId: PLATFORM_SENDER, tool: 'alert', channel: 'imessage', recipientId: FIRST },
      () => { recordAtDoor({ outcome: 'delivered', channel: 'imessage' }); return recordPersonTold('t-1', { deliveryId: currentOutboundDeliveryId()!, via: 'owner_notice' }); },
    );
    expect(toFirst).toMatchObject({ kind: 'refused', reason: 'not-the-owner-or-requester' });
  });

  it('control: no records at all — the legacy key alone is the owner', () => {
    setConfig('imessage_default_sender', FIRST);
    const { sentTo, told } = noticeToTheBridgesOwner('t-1');
    expect(sentTo).toBe(FIRST);
    expect(told?.kind).toBe('applied');
  });
});
