// PHASE-2 T8c2 item 5 — the owner's own close, and the four ways it must NOT leak.
//
// The policy: the owner's explicit dashboard close reaches `done` even when no delivery can
// be resolved, because G7 exists to stop the ENGINE and the AGENT asserting completion on
// their own say-so, and the owner is the person the work was FOR. The design and its
// alternative are argued in `../deliveries.ts`; this file is the part that has to keep
// holding after somebody stops reading comments.
//
// The receipt is only safe because every consumer of `deliveries` ignores it. That is not an
// assumption here — the enumeration is re-run as a clause, and the three specific consumers
// most likely to be fooled are exercised directly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-owner-close-test', 'dojo.db'),
  };
});
vi.mock('../../../memory/conversations.js', () => ({
  resolveOrCreateConversation: () => 'conv-should-not-be-used',
}));

import { createWorkTable, seedTrackerTask } from '../../../work/__tests__/work-fixture.js';
import { recordOwnerCloseReceipt, recordDelivery } from '../deliveries.js';

const W = 'task-1';
const AGENT = 'a1';
const SRC = path.join(__dirname, '..', '..', '..');

const receipts = (): Array<Record<string, unknown>> =>
  mockDb.current!.prepare(
    `SELECT * FROM deliveries WHERE tool = 'owner-close' ORDER BY rowid`,
  ).all() as Array<Record<string, unknown>>;

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  createWorkTable(db);
  db.exec(`
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER,
      tool TEXT NOT NULL, channel TEXT NOT NULL, recipient_id TEXT, recipient_display TEXT,
      conversation_id TEXT, root_kind TEXT, root_id TEXT, message_id TEXT, receipt_id TEXT,
      outcome TEXT NOT NULL, detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  seedTrackerTask(db, { id: W, title: 'something the owner is closing himself', agentId: AGENT });
});

describe('the receipt is an honest record, not a claimed send', () => {
  it('records one row that says exactly what happened', () => {
    const id = recordOwnerCloseReceipt(W, 'the dashboard task board');
    expect(id).not.toBeNull();
    const rows = receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id, agent_id: AGENT, tool: 'owner-close', channel: 'none', outcome: 'owner_closed',
    });
    expect(rows[0].message_id).toBeNull();
    expect(rows[0].receipt_id).toBeNull();
    expect(rows[0].conversation_id).toBeNull();
    expect(String(rows[0].detail)).toMatch(/Nothing was delivered by this row/);
  });

  it('carries NO root lineage — migration 135s own reasoning, applied live', () => {
    // 135:230-232: a sentinel carrying `root_id=<task id>` "would have manufactured per-task
    // delivery evidence for the PM's own consult path". This row must not carry it either.
    recordOwnerCloseReceipt(W, 'the dashboard task board');
    expect(receipts()[0].root_id).toBeNull();
    expect(receipts()[0].root_kind).toBeNull();
  });

  it('is one row PER CLOSE, so the instant of each is on the record', () => {
    seedTrackerTask(mockDb.current!, { id: 'task-2', title: 'another', agentId: AGENT });
    const a = recordOwnerCloseReceipt(W, 'the dashboard task board');
    const b = recordOwnerCloseReceipt('task-2', 'the dashboard task board');
    expect(a).not.toBe(b);
    expect(receipts()).toHaveLength(2);
  });

  it('refuses an id that does not resolve, so G7 refuses the close', () => {
    expect(recordOwnerCloseReceipt('no-such-work', 'the dashboard task board')).toBeNull();
    expect(receipts()).toHaveLength(0);
  });
});

describe('the receipt is invisible to every consumer of the ledger', () => {
  it('NEGATIVE CONTROL: the PM consult path does not see it as delivery evidence', () => {
    // `tracker/delivery-evidence.ts:119` and `tracker/task-stamps.ts:66`, verbatim shape.
    recordOwnerCloseReceipt(W, 'the dashboard task board');
    const channels = mockDb.current!.prepare(
      `SELECT DISTINCT channel FROM deliveries WHERE agent_id = ? AND outcome = 'delivered'`,
    ).all(AGENT);
    expect(channels).toEqual([]);
  });

  it('NEGATIVE CONTROL: the tracker-store close resolver does not offer it to a later close', () => {
    // `work/tracker-store.ts:377` — if this returned the receipt, an AGENT's next close
    // would inherit the owner's exemption, which is exactly the leak to prevent.
    recordOwnerCloseReceipt(W, 'the dashboard task board');
    const hit = mockDb.current!.prepare(
      `SELECT id FROM deliveries WHERE agent_id = ? AND outcome = 'delivered' AND tool <> 'engine-ack'`,
    ).get(AGENT);
    expect(hit).toBeUndefined();
  });

  it('NEGATIVE CONTROL: the dashboard dedup lookup cannot reach it', () => {
    // `agent/v2/outbound.ts:430` is the ONE reader with no outcome filter. It is keyed on
    // `channel='dashboard'` AND a real message id; the receipt is `channel='none'` with a
    // NULL message id, so it is unreachable twice over.
    recordOwnerCloseReceipt(W, 'the dashboard task board');
    const hit = mockDb.current!.prepare(
      `SELECT id FROM deliveries WHERE agent_id = ? AND channel = 'dashboard' AND message_id = ?`,
    ).get(AGENT, null);
    expect(hit).toBeUndefined();
  });

  it('POSITIVE CONTROL: a REAL delivery by the same agent IS seen by those same queries', () => {
    // Without this, the three clauses above would pass on an empty table and prove nothing.
    recordOwnerCloseReceipt(W, 'the dashboard task board');
    recordDelivery({
      agentId: AGENT, tool: 'auto-route', channel: 'dashboard', outcome: 'delivered',
      messageId: 'm1', conversationId: 'c1',
    });
    const channels = mockDb.current!.prepare(
      `SELECT DISTINCT channel FROM deliveries WHERE agent_id = ? AND outcome = 'delivered'`,
    ).all(AGENT);
    expect(channels).toEqual([{ channel: 'dashboard' }]);
    const dedup = mockDb.current!.prepare(
      `SELECT id FROM deliveries WHERE agent_id = ? AND channel = 'dashboard' AND message_id = ?`,
    ).get(AGENT, 'm1');
    expect(dedup).toBeDefined();
  });
});

describe('the enumeration the design rests on, re-derived rather than trusted', () => {
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'migrations') continue;
        walk(fp, acc);
      } else if (e.name.endsWith('.ts')) acc.push(fp);
    }
    return acc;
  };
  /** Statement bodies that read `deliveries`, comments blanked so prose is never counted. */
  const readers = (): Array<{ file: string; stmt: string }> => {
    const out: Array<{ file: string; stmt: string }> = [];
    for (const f of walk(SRC)) {
      const src = fs.readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
      const re = /(?:FROM|JOIN)\s+deliveries\b([\s\S]{0,400}?)(?=`|;\s*$)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        out.push({ file: path.relative(SRC, f).split(path.sep).join('/'), stmt: m[0] });
      }
    }
    return out;
  };

  it('every production reader of `deliveries` either filters outcome=delivered or cannot see this row', () => {
    // TWO ALLOWED SHAPES, both NAMED rather than counted away. Anything else appearing here
    // is a reader that would treat an owner close as delivery evidence, and the design stops
    // being safe the moment one exists.
    //
    //   (a) the dashboard dedup lookup (`agent/v2/outbound.ts`), keyed on
    //       `channel = 'dashboard'` AND a real `message_id`, which this row has neither of;
    //   (b) an existence lookup keyed on `id = ?` (`work/store.ts`'s `deliveryExists` and
    //       `evidenceResolves`). These are the queries that ask "does the pointer resolve",
    //       which is exactly G7's own question, and the receipt is SUPPOSED to answer yes —
    //       that is the whole mechanism. It is not a leak: neither is a search, so no caller
    //       can DISCOVER the receipt through them; a caller has to already hold its id, and
    //       the only resolver that hands ids out (`tracker-store.ts:deliveryForAgentSince`)
    //       filters `outcome='delivered'`.
    const unfiltered = readers()
      .filter((r) => !/outcome\s*=\s*'delivered'/i.test(r.stmt))
      .filter((r) => !/channel\s*=\s*'dashboard'[\s\S]*message_id\s*=/i.test(r.stmt))
      .filter((r) => !/\bid\s*=\s*\?/.test(r.stmt))
      .map((r) => r.file);
    expect([...new Set(unfiltered)]).toEqual([]);
  });

  it('the enumeration is not vacuous — it really found the readers', () => {
    expect(readers().length).toBeGreaterThanOrEqual(8);
  });

  it('PLANTED FAULT: a new reader with no outcome filter is caught', () => {
    // The rule has to bite on a statement, not just on a file list, or the clause above is a
    // spelling check. Both allowed shapes must still pass, and a bare scan must not.
    const filt = (stmt: string): boolean =>
      !/outcome\s*=\s*'delivered'/i.test(stmt)
      && !/channel\s*=\s*'dashboard'[\s\S]*message_id\s*=/i.test(stmt)
      && !/\bid\s*=\s*\?/.test(stmt);
    expect(filt(`FROM deliveries WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`)).toBe(true);
    expect(filt(`FROM deliveries WHERE agent_id = ? AND outcome = 'delivered'`)).toBe(false);
    expect(filt(`FROM deliveries WHERE id = ?`)).toBe(false);
    expect(filt(`FROM deliveries WHERE channel = 'dashboard' AND message_id = ?`)).toBe(false);
  });
});
