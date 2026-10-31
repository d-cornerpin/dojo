// ════════════════════════════════════════════════════════════════════════════════
// THE IMESSAGE SEND-FAILURE DOOR NAMES ONE CAUSE FOR THREE.
//
// `comms.ts` returns this string whenever the send came back with nothing sent:
//
//   "iMessage delivery failed at the system level - neither the imsg CLI nor
//    AppleScript could deliver."
//
// But the shape `{ ok: false, sentFiles: [], textSent: false }` is ALSO exactly what
// `sendIMessageWithAttachmentsInner` returns when the owner pressed Stop mid-send
// (`imessage-bridge.ts`, the `cut` / `not-started` branch) - a send that was stopped
// on purpose reads to the model like a broken transport, and the model tells the user
// the system failed them. The door has to name both causes it actually covers.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-imessage-send-failure-wording', 'dojo.db'),
  };
});

// The bridge is RUNNING here — the send goes out and comes back with nothing sent.
// The transport call itself is replaced with the exact shape the real bridge returns
// both for a transport failure and for an owner-Stop cut; only the door's wording is
// under test. The safe-sender readers stay real (spread from the original).
vi.mock('../../../../services/imessage-bridge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../services/imessage-bridge.js')>();
  return {
    ...real,
    getIMBridgeStatus: () => ({
      running: true, enabled: true, connected: true,
      approvedSenders: [], safeSenders: [], lastSeenRowId: 0,
    }),
    sendIMessageWithAttachments: vi.fn(async () => ({
      ok: false, sentFiles: [], failedFiles: [], textSent: false,
    })),
  };
});

import { runMigrations } from '../../../../db/migrations.js';
import { commsHandlers } from '../comms.js';
import { reloadApprovedSenders } from '../../../../services/imessage-bridge.js';

const AGENT = 'sub-agent-1';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  const fresh = new Database(':memory:');
  fresh.pragma('foreign_keys = ON');
  mockDb.current = fresh;
  runMigrations();
  fresh.pragma('foreign_keys = ON');
  fresh.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Sub', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db().prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)",
  ).run(JSON.stringify([{ name: 'Yorvak', address: '+15550200', is_primary: true }]));
  reloadApprovedSenders();
});

describe('the imessage send-failure door', () => {
  const send = () => commsHandlers['imessage_send']!(
    { agentId: AGENT, args: { recipient: '+15550200', message: 'hi' } } as never,
  );

  it('is an error when nothing went out', async () => {
    const out = await send();
    expect(out.isError).toBe(true);
  });

  it('says nothing went out, and names the owner-Stop as a cause beside the transport', async () => {
    const out = await send();
    expect(out.content).toContain('iMessage NOT sent - nothing went out');
    expect(out.content).toContain('owner pressed Stop');
  });

  it('no longer blames the system level as the only cause', async () => {
    const out = await send();
    expect(out.content).not.toContain('at the system level');
  });
});
