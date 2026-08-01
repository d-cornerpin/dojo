// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 T7 Step 1 — THE DELIVERIES LANE (research 18 §open-1, the inherited echo-strip
// rider).
//
// EVERY CLAUSE BELOW FAILS AT T7's BASE COMMIT `5d82dc8`, and they fail for two different
// reasons, which is the point:
//
//   • §1-§3 (the REPLACEMENT) fail because the thing they test did not exist: there was no
//     lane, only `engine.pending-question` — a registry-exempt `pushEngineMessage` reading
//     ONE delivery (`LIMIT 1`), quoting it at 300 chars, with no declaration, no budget, no
//     truncate and no entry in the receipt. The rows it could not carry were carried by the
//     ECHO ROW DUPLICATION instead (`persistCrossConvSendEcho`), which is exactly why the
//     ledger deferred the strip "until the assembler reads deliveries rows natively".
//
//   • §4 (the BUDGET) fails because a post-budget lane had never had to enforce one. The
//     other seven reserve a FIXED string's cost; this one renders a variable number of rows
//     of variable length, so its reserve is the first that can be exceeded — and a reserve
//     that can be exceeded is a number in a table, not a budget.
//
// THE FIXTURE SCHEMA IS HAND-BUILT, following `agent/v2/__tests__/delivery-links.test.ts`
// (the sibling that pins the receipt join). The subject here is the RENDER, and the
// projection this reads through is that file's subject, already proven against its own
// planted decoys.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
// The legacy alias prong resolves recipient hints through the contacts store; the lane's
// subject is not contact resolution, and an unstubbed store would open the real database.
vi.mock('../../contacts/store.js', () => ({ findMatchingContact: () => null }));

import {
  DELIVERIES_LANE, DELIVERIES_LANE_ID,
  renderDeliveriesLane, truncateDeliveriesLane, renderDeliveriesLaneMessage,
  deliveriesLaneWorstCaseTokens,
  type DeliveriesLaneContext, type DeliveriesLanePayload,
} from '../deliveries-lane.js';
import { LANE_LIMITS, POST_BUDGET_LANES, laneLimit, type LaneRender } from '../lanes.js';
import { MessageSlot } from '../../prompt/registry/types.js';
import { getMessageEntries } from '../../prompt/registry/registry.js';
import '../../prompt/registry/entries.js';
import { estimateTokens } from '../budget.js';

const AGENT = 'p3t7-deliveries';
const CONV = 'conv-owner-im';
const HOUR = 3_600_000;
const rel = (hoursAgo: number): string =>
  new Date(Date.now() - hoursAgo * HOUR).toISOString().replace('T', ' ').slice(0, 19);

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, turn_number INTEGER, tool TEXT, channel TEXT,
      recipient_id TEXT, recipient_display TEXT, conversation_id TEXT, message_id TEXT,
      receipt_id TEXT, outcome TEXT, detail TEXT, created_at TEXT
    );
    CREATE TABLE tool_receipts (
      id TEXT PRIMARY KEY, agent_id TEXT, tool TEXT, turn_number INTEGER,
      sent_text TEXT, conv_key TEXT, verified INTEGER, recipient TEXT, created_at TEXT
    );
  `);
  mockDb.current = db;
});

let seq = 0;
/** One delivered send INTO `CONV`, with its receipt carrying the verbatim text. */
function seedSend(text: string, hoursAgo: number, over: Record<string, unknown> = {}): string {
  const id = `d-${++seq}`;
  const rid = `r-${seq}`;
  mockDb.current!.prepare(
    `INSERT INTO tool_receipts (id, agent_id, tool, turn_number, sent_text, conv_key, verified, recipient, created_at)
     VALUES (?, ?, 'imessage_send', 40, ?, 'k', 1, 'Dave', ?)`,
  ).run(rid, AGENT, text, rel(hoursAgo));
  const row: Record<string, unknown> = {
    id, agent_id: AGENT, turn_number: 40, tool: 'imessage_send', channel: 'imessage',
    recipient_id: '+15550000', recipient_display: 'Dave', conversation_id: CONV,
    message_id: null, receipt_id: rid, outcome: 'delivered', detail: null,
    created_at: rel(hoursAgo), ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`,
  ).run(row);
  return id;
}

const ctx = (over: Partial<DeliveriesLaneContext> = {}): DeliveriesLaneContext => ({
  agentId: AGENT,
  conversationId: CONV,
  counterpartyName: 'Dave',
  recipientHints: [],
  alreadyVisible: () => false,
  ...over,
});

const render = (over: Partial<DeliveriesLaneContext> = {}) =>
  renderDeliveriesLane(ctx(over)) as LaneRender<DeliveriesLanePayload> | null;
const text = (over: Partial<DeliveriesLaneContext> = {}) => renderDeliveriesLaneMessage(ctx(over));

// ════════════════════════════════════════════════════════════════════════════════════════
// 1. THE REPLACEMENT — the recipient's next turn sees the question it was asked, with NO
//    echo row anywhere. This is the clause the STRIP depends on.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('the lane reads the deliveries rows natively', () => {
  it('renders the question the agent asked, with no echo row in the array', () => {
    seedSend('What is the account number for the boat insurance?', 2);
    const out = text();
    expect(out).toContain('What is the account number for the boat insurance?');
    expect(out).toContain('Dave');
    // Nothing in the array: the ONLY source was the deliveries row.
    expect(out).not.toContain('[Sent via');
  });

  // THE NO-BLEED HALF, and it is here because the STRIP needs it here. RC-1's gate (a)
  // (`memory/__tests__/rc1-conversation-scoping.test.ts`) held this requirement over the echo
  // ROW: the question the agent asked Sam must reach SAM's next turn and must never appear on
  // Maya's. The row is deleted at PHASE-3 T7 Step 2, so the requirement moves to the mechanism
  // that now owns it — and it is structurally safer here, because the lane cannot bleed by
  // construction: `recentDeliveriesToConversation` is scoped by the conversation being served,
  // where the echo row's scoping depended on the assembler filtering a row it had persisted
  // into someone else's conversation on purpose.
  it('a send into ANOTHER conversation never surfaces on this turn, and DOES on that one', () => {
    seedSend('whats your Delta SkyMiles number?', 2, { conversation_id: 'conv-sam', recipient_display: 'Sam' });
    // Maya's turn: the agent's question to Sam is not hers to see.
    expect(text()).toBeNull();
    // Sam's turn: it is exactly what he needs to bind a bare answer to.
    expect(text({ conversationId: 'conv-sam', counterpartyName: 'Sam' })).toContain('SkyMiles');
  });

  it('carries MORE THAN ONE question, newest first — the echo rows\' own job', () => {
    seedSend('question ONE about the invoice', 6);
    seedSend('question TWO about the flight', 4);
    seedSend('question THREE about the boat', 1);
    const out = text()!;
    expect(out).toContain('question ONE');
    expect(out).toContain('question TWO');
    expect(out).toContain('question THREE');
    expect(out.indexOf('question THREE')).toBeLessThan(out.indexOf('question ONE'));
  });

  it('honours the declared row cap and the declared window', () => {
    for (let i = 0; i < 5; i++) seedSend(`send number ${i}`, 5 - i);
    const r = render()!;
    expect(r.payload!.rows).toHaveLength(laneLimit(DELIVERIES_LANE_ID, 'rows', 'deliveries'));

    // A send older than the declared window is not this turn's pending question.
    mockDb.current!.exec('DELETE FROM deliveries');
    seedSend('ancient history', laneLimit(DELIVERIES_LANE_ID, 'retrieval', 'windowHours') + 1);
    expect(render()).toBeNull();
  });

  it('never quotes the dashboard/voice lane back at the model (it is already in the tail)', () => {
    seedSend('this went to the dashboard', 1, { channel: 'dashboard' });
    expect(render()).toBeNull();
  });

  it('quotes at the declared char cap, not the whole message', () => {
    const cap = laneLimit(DELIVERIES_LANE_ID, 'chars', 'quoted');
    seedSend('y'.repeat(cap + 500), 1);
    expect(text()!).not.toContain('y'.repeat(cap + 1));
    expect(text()!).toContain('y'.repeat(cap));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 2. BEHAVIOUR PRESERVED for the case RC-1's header already served
// ════════════════════════════════════════════════════════════════════════════════════════
describe('the one-row render is RC-1\'s header, byte for byte', () => {
  it('reproduces the exact wording the pending-question header emitted', () => {
    seedSend('the only question', 2);
    // The literal from `loop.ts` pre-T7 (`engine.pending-question`), reproduced here so a
    // wording change to the common case cannot happen silently.
    expect(text()).toBe('[Your most recent message to Dave, sent 2 hours ago: "the only question"]');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 3. THE DEDUP — the echo rows are still being written during T7's quiet window
// ════════════════════════════════════════════════════════════════════════════════════════
describe('a row the assembled array already carries is not quoted twice', () => {
  it('skips the delivery whose echo row is still in the tail, and keeps the others', () => {
    seedSend('the echoed question', 3);
    seedSend('the un-echoed question', 1);
    const out = text({
      alreadyVisible: (probe) => 'the echoed question'.startsWith(probe.slice(0, 19)),
    })!;
    expect(out).toContain('the un-echoed question');
    expect(out).not.toContain('the echoed question');
  });

  it('renders NOTHING when every row is already visible — never an empty frame', () => {
    seedSend('all of it is in the tail', 1);
    expect(text({ alreadyVisible: () => true })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 4. THE BUDGET IS ENFORCED, not merely declared
// ════════════════════════════════════════════════════════════════════════════════════════
describe('the declared reserve is a bound the render obeys', () => {
  const declared = () => POST_BUDGET_LANES.find((l) => l.id === DELIVERIES_LANE_ID)!;

  it('is declared in the lane table with a position, a budget and a truncate', () => {
    const d = declared();
    expect(d).toBeTruthy();
    expect(d.slot).toBe(MessageSlot.Deliveries);
    expect(LANE_LIMITS[DELIVERIES_LANE_ID]).toBeTruthy();
    expect(typeof DELIVERIES_LANE.truncate).toBe('function');
    expect(DELIVERIES_LANE.maxTokens).toBe(d.reserveTokens);
  });

  it('pins the declared literal to the generator that derives it', () => {
    // A reserve nobody can re-derive is a rumour (#14). This calls the renderer.
    expect(declared().reserveTokens).toBe(deliveriesLaneWorstCaseTokens());
  });

  it('NO input can exceed the reserve — three 5,000-char sends still fit', () => {
    for (let i = 0; i < 3; i++) seedSend('z'.repeat(5000), 3 - i);
    const out = text()!;
    expect(estimateTokens(out)).toBeLessThanOrEqual(declared().reserveTokens);
  });

  it('and the reserve is bound by the FIT too, not only by the caps', () => {
    // MEASURED, not assumed: removing the fit from `renderDeliveriesLaneMessage` leaves the
    // clause above GREEN, because the row cap and the quote cap already hold the render
    // under the reserve — the reserve IS their arithmetic. So the enforcement needs its own
    // control, one that starts from a render the caps could not have produced. If the caps
    // ever drift apart from the reserve, this is the clause that still refuses.
    const oversized: LaneRender<DeliveriesLanePayload> = {
      messages: [{ role: 'user', content: 'x'.repeat(20_000) }],
      tokens: 5_000,
      payload: {
        rows: [3, 2, 1].map((h) => ({ ago: `${h} hours ago`, text: 'w'.repeat(2_000) })),
        counterpartyName: 'Dave',
        cut: false,
      },
    };
    const fitted = truncateDeliveriesLane(oversized, declared().reserveTokens);
    expect(fitted.tokens).toBeLessThanOrEqual(declared().reserveTokens);
    expect(fitted.messages[0].content as string).toContain('shortened to fit');
  });

  it('truncate drops the OLDEST row first and says that it shortened', () => {
    seedSend('the oldest question', 5);
    seedSend('the newest question', 1);
    const full = render()!;
    const cut = truncateDeliveriesLane(full, Math.floor(full.tokens / 2));
    const body = cut.messages[0].content as string;
    expect(body).toContain('the newest question');
    expect(body).not.toContain('the oldest question');
    expect(body).toContain('shortened to fit');
    expect(cut.tokens).toBeLessThan(full.tokens);
  });

  it('drops ONE row at a time, keeping every row the budget can still pay for', () => {
    // The clause that separates "shrink by priority" from "shrink to one": three rows and a
    // budget that fits two must keep TWO — the newest two. A truncate that jumps straight
    // to the single-row frame passes every other clause here and fails this one.
    // Long rows on purpose: with short ones the list frame and the truncation marker cost
    // more than the rows do, so "one row fewer" is not a smaller render and the clause
    // would be measuring the frame instead of the drop.
    const pad = (s: string) => `${s} ${'detail.'.repeat(34)}`;
    seedSend(pad('the oldest of three'), 6);
    seedSend(pad('the middle of three'), 4);
    seedSend(pad('the newest of three'), 1);
    const full = render()!;
    const twoRows = truncateDeliveriesLane(full, Math.ceil(full.tokens * 0.8));
    expect(twoRows.payload!.rows).toHaveLength(2);
    const body = twoRows.messages[0].content as string;
    expect(body).toContain('the newest of three');
    expect(body).toContain('the middle of three');
    expect(body).not.toContain('the oldest of three');
  });

  it('never truncates to nothing: one row survives with its quote shortened', () => {
    seedSend('a single very long question '.repeat(10), 1);
    const full = render()!;
    const cut = truncateDeliveriesLane(full, 12);
    expect(cut.messages).toHaveLength(1);
    expect((cut.messages[0].content as string).length).toBeGreaterThan(0);
    expect(cut.tokens).toBeLessThan(full.tokens);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 5. THE RECEIPT TELLS THE TRUTH ABOUT IT
// ════════════════════════════════════════════════════════════════════════════════════════
// FOUND LIVE, not imagined: the first real turn that carried this lane produced a receipt
// whose lane table said `lane.deliveries … post-budget lane did not fire on this turn`
// while the rendered message sat six rows below it in the same receipt. The assembler
// declares this lane and the LOOP fills it, so the assembler's own report cannot know —
// which is exactly the case T6 already solved for `lane.loop-tail`. A dropped section that
// looks identical to an absent one is the defect this phase exists to delete, and the
// receipt is the one place that can state it, because it is written after the tail-append.
describe('the receipt attributes the lane to itself, measured', () => {
  const REAL_HOME = process.env.HOME;
  const REAL_MODE = process.env.DOJO_RECEIPT_MODE;

  it('records the lane as ADMITTED with its measured cost, and does not double-count it', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-t7-receipt-'));
    process.env.HOME = scratch;
    process.env.DOJO_RECEIPT_MODE = 'meta';
    // RECEIPTS_ROOT resolves from os.homedir() at module load, so the import comes after.
    const { writeContextReceipt } = await import('../../agent/v2/receipt.js');
    const grant = (id: string, slot: number) => ({
      id, slot, priority: Number.MAX_SAFE_INTEGER, requested: 0, granted: 0,
      status: 'empty' as const, reason: 'post-budget lane did not fire on this turn',
    });
    writeContextReceipt({
      agentId: AGENT, modelId: 'm', turnNumber: 1, loopCount: 1, useTools: true,
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'the live conversation' },
        { role: 'user', content: '[Turn context]' },
        { role: 'user', content: `[Your most recent message to Dave, sent 2 hours ago: "${'q'.repeat(200)}"]` },
      ],
      messageEntryIds: ['lane.fresh-tail', 'msg.turn-context', 'msg.deliveries'],
      volatileFrom: 1,
      allocation: {
        budgetTokens: 1000, reservedTokens: 0, spentTokens: 0, offTheTopTokens: 0,
        admittedIds: [], overBudget: [],
        grants: [grant('lane.loop-tail', MessageSlot.TurnContext), grant(DELIVERIES_LANE_ID, MessageSlot.Deliveries)],
      },
    });
    // The write is fire-and-forget (`void fs.promises.mkdir(...).then(...)`), so the read
    // waits for it rather than racing it.
    const dir = path.join(scratch, '.dojo', 'receipts', AGENT);
    for (let i = 0; i < 100 && !fs.existsSync(dir); i++) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 100 && fs.readdirSync(dir).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const file = fs.readdirSync(dir)[0];
    const rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const lanes: Array<{ id: string; status: string; granted: number; reason: string }> = rec.assembly.lanes;
    const del = lanes.find((l) => l.id === DELIVERIES_LANE_ID)!;
    const tail = lanes.find((l) => l.id === 'lane.loop-tail')!;

    expect(del.status).toBe('admitted');
    expect(del.granted).toBeGreaterThan(50);
    expect(del.reason).toContain('deliveries lane, MEASURED');
    expect(del.reason).toContain('316-token reserve');
    // The same tokens must not also be billed to the loop tail's 900.
    expect(tail.reason).toContain('msg.turn-context');
    expect(tail.reason).not.toContain('msg.deliveries');
    expect(tail.granted).toBeLessThan(del.granted);

    process.env.HOME = REAL_HOME;
    if (REAL_MODE === undefined) delete process.env.DOJO_RECEIPT_MODE;
    else process.env.DOJO_RECEIPT_MODE = REAL_MODE;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 6. POSITION — the cache-prefix law is the reason this lane is where it is
// ════════════════════════════════════════════════════════════════════════════════════════
describe('the lane sits past the volatile boundary, in the preserved near-tail order', () => {
  it('declares a slot after turn-context and before peer-status', () => {
    expect(MessageSlot.Deliveries).toBeGreaterThan(MessageSlot.TurnContext);
    expect(MessageSlot.Deliveries).toBeLessThan(MessageSlot.PeerStatus);
  });

  it('is emitted through the registry, at the slot the lane declares', () => {
    const entry = getMessageEntries().find((e) => e.id === 'msg.deliveries');
    expect(entry, 'msg.deliveries is not registered').toBeTruthy();
    expect(entry!.slot).toBe(DELIVERIES_LANE.slot);
  });

  it('carries a volatile SHAPE, which is what forces it past the boundary', () => {
    seedSend('why this cannot sit in the cached prefix', 2);
    // The kit's assembled-context gate refuses this shape ahead of MessageSlot.TurnContext.
    expect(text()!).toMatch(/\b\d+\s+(?:seconds?|minutes?|hours?)\s+ago\b/);
  });
});
