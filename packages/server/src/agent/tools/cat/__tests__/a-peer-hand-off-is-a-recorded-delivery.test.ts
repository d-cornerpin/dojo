// ════════════════════════════════════════════════════════════════════════════════════════
// t116 E3 — THE HAND-OFF THAT HAPPENED AND WAS NEVER RECORDED.
//
// From the release blast, deterministic on all three attempts: `deliveries[send_to_agent]=0
// [none]` — while the hop itself WORKED every time (`peer inbox rows=1-2`, `hops=1`, the token
// came back). So the platform did the thing and then could not say it had.
//
// ── WHAT WAS AND WAS NOT WRONG, re-derived at this head ──
// The blast's spelling was right: `deliveries.tool` and `.outcome` are real columns,
// `'send_to_agent'` is the exact literal the engine uses, `'delivered'` is a real member of
// the typed union. The handler wrote THREE bookkeeping rows on a successful send — the A2A
// reply mark, the audit row, and a tool receipt — and no `deliveries` row at all.
// `git log -S recordAtDoor` over the handler returns zero commits: this was never a
// regression, the receipt was never there to lose.
//
// The transport names the gap against itself, at `recordPieceDelivery`:
//     "PINNED §8 names `send_to_agent` as one of the ten unrecorded paths T5 closes AT THE
//      DOOR — when it does, this call becomes that door's…"
// That closure is what this file holds.
//
// ── ATTRIBUTION IS THE POINT, NOT MERELY PRESENCE ──
// There WAS one producer of `tool='send_to_agent'` rows: the reply-spine call above, reached
// only through an open/failed JOIN, and attributed to `p.fromAgent` — the REPLYING PEER. So
// the row that existed answered "who replied", and the question nobody could answer was
// "which agent handed this work over". §1 asserts the sender, not just the row.
//
// ── AND THE CENSUS FOUND A SECOND ONE ──
// §4 is a census over the A2A door's own receipt sites, and writing it is what surfaced
// `broadcast_to_group`: the identical shape — a receipt claiming a send to a named recipient
// with no ledger row behind it. It is fixed here rather than exempted, because a census with a
// carve-out for the case it just found is not a census. §3 drives it.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t116-e3', 'dojo.db'),
  };
});

/** THE TRANSPORT, under the test's control. This file is about what the DOOR records, so the
 *  hop itself is a dial whose answer the test chooses — delivered, or refused with a stated
 *  protocol reason, which are the two shapes the handler branches on. */
const deliverSpy = vi.fn();
vi.mock('../../../a2a-transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../a2a-transport.js')>()),
  deliverA2AMessage: (...a: unknown[]) => deliverSpy(...(a as [])),
  isNoWakeIntent: () => false,
}));

vi.mock('../../../../gateway/ws.js', () => ({
  broadcast: () => undefined,
  stampPersistedRow: (e: unknown) => e,
}));

import { agentsHandlers } from '../agents.js';
import { runMigrations } from '../../../../db/migrations.js';

const SENDER = 'zargo';
const TARGET = 'quilba';
const GROUP = 'group-fictional-1';
const THREAD = 'thread-fictional-1';

type DeliveriesRow = {
  agent_id: string; tool: string; channel: string; outcome: string;
  recipient_id: string | null; recipient_display: string | null; detail: string | null;
};

const deliveries = (tool?: string): DeliveriesRow[] => {
  const sql = tool
    ? 'SELECT * FROM deliveries WHERE tool = ? ORDER BY rowid'
    : 'SELECT * FROM deliveries ORDER BY rowid';
  return (tool ? mockDb.current!.prepare(sql).all(tool) : mockDb.current!.prepare(sql).all()) as DeliveriesRow[];
};

const receipts = (tool: string): Array<Record<string, unknown>> =>
  mockDb.current!.prepare('SELECT * FROM tool_receipts WHERE tool = ? ORDER BY rowid')
    .all(tool) as Array<Record<string, unknown>>;

/** The tool, through the door the model actually calls. */
async function sendToAgent(args: Record<string, unknown> = {}): Promise<string> {
  const h = agentsHandlers['send_to_agent'];
  const r = await h({
    agentId: SENDER,
    args: { agent: TARGET, intent: 'ASSIGN', payload: 'Please take the research leg.', ...args },
  } as unknown as Parameters<typeof h>[0]);
  return r.content;
}

async function broadcastToGroup(args: Record<string, unknown> = {}): Promise<string> {
  const h = agentsHandlers['broadcast_to_group'];
  const r = await h({
    agentId: SENDER,
    args: { group_id: GROUP, intent: 'FYI', payload: 'Standing up the new lane.', ...args },
  } as unknown as Parameters<typeof h>[0]);
  return r.content;
}

const delivered = (over: Record<string, unknown> = {}) => ({
  delivered: true, threadId: THREAD, messageId: 'a2a-msg-1', ...over,
});
const refused = (reason: string) => ({ delivered: false, reason, threadId: THREAD });

beforeEach(() => {
  vi.clearAllMocks();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agent_groups (id, name, created_by) VALUES (?, 'The Fictional Lane', ?)`,
  ).run(GROUP, SENDER);
  for (const [id, name] of [[SENDER, 'Zargo'], [TARGET, 'Quilba'], ['tyndo', 'Tyndo']] as const) {
    db.prepare(
      `INSERT INTO agents (id, name, status, group_id, session_started_at)
       VALUES (?, ?, 'idle', ?, '1970-01-01')`,
    ).run(id, name, GROUP);
  }
  deliverSpy.mockResolvedValue(delivered());
});

// ── §1 — the delivered hand-off is recorded, and recorded to the SENDER ──────────────────

describe('§1 a delivered peer hand-off writes its own receipt', () => {
  it('⚠ THE RED: the hop succeeds and the ledger now has a row for it', async () => {
    await sendToAgent();

    // The blast's own measurement — `deliveries[send_to_agent]=0 [none]` — read off the table.
    const rows = deliveries('send_to_agent');
    expect(rows.length, 'the hand-off happened and the ledger still cannot say so').toBe(1);
    expect(rows[0].outcome).toBe('delivered');
    // The peer lane, which mints no `conversations` row by construction: coordination traffic
    // is not a human conversation, and inventing one would put it inside the owner's.
    expect(rows[0].channel).toBe('a2a');
  });

  it('⚠ ATTRIBUTION: the row belongs to the DELEGATOR, which is the question nothing could answer', async () => {
    await sendToAgent();

    const row = deliveries('send_to_agent')[0];
    // The pre-existing producer credited the REPLYING PEER (`p.fromAgent` on the join spine),
    // so "which agent handed this over" had no answer anywhere. Presence alone would not have
    // caught that; this is the clause that pins it.
    expect(row.agent_id, 'the hand-off was credited to somebody other than the sender')
      .toBe(SENDER);
    expect(row.recipient_id, 'the recipient is not the agent the work went to').toBe(TARGET);
    // The resolved display name, not the raw ref the model happened to type.
    expect(row.recipient_display).toBe('Quilba');
  });

  it('the receipt and the ledger row are ONE send said twice, not two sends', async () => {
    await sendToAgent();
    // The tool receipt was always written; the ledger row is the half that was missing. Both
    // must describe the same single hand-off — a door that double-counts is its own defect.
    expect(receipts('send_to_agent').length).toBe(1);
    expect(deliveries('send_to_agent').length).toBe(1);
  });

  it('the thread identity rides along, so the row can be joined back to the hop', async () => {
    await sendToAgent();
    const row = deliveries('send_to_agent')[0];
    expect(String(row.detail), 'the intent is not on the row').toContain('ASSIGN');
  });

  it('a second, genuinely different hand-off writes a second row', async () => {
    // Non-vacuity in the other direction: a clause that passes on "exactly one row" would
    // also pass if the writer were pinned to firing once per process.
    await sendToAgent();
    deliverSpy.mockResolvedValue(delivered({ threadId: 'thread-fictional-2' }));
    await sendToAgent({ payload: 'And the write-up leg too.' });
    expect(deliveries('send_to_agent').length).toBe(2);
  });
});

// ── §2 — the other direction: a refusal is recorded as a refusal ──────────────────────────

describe('§2 a hand-off that did NOT happen is recorded honestly', () => {
  it('a protocol drop is `suppressed` — the platform working as designed, never a delivery', async () => {
    deliverSpy.mockResolvedValue(refused('SEMANTIC_DUPLICATE'));

    await sendToAgent();

    const rows = deliveries('send_to_agent');
    expect(rows.length, 'a refused send left no trace at all').toBe(1);
    expect(rows[0].outcome, 'a dropped message was filed as delivered').toBe('suppressed');
    expect(String(rows[0].detail)).toContain('SEMANTIC_DUPLICATE');
  });

  it('every GENUINE policy drop records `suppressed`, not one of them', async () => {
    // The three refusals the transport still makes on purpose. `TERMINAL_THREAD_CLOSED` was in
    // this list and has been ruled OUT of it — see the clause below.
    for (const reason of ['SEMANTIC_DUPLICATE', 'HOP_LIMIT_EXCEEDED', 'AWAITING_REPLY']) {
      deliverSpy.mockResolvedValue(refused(reason));
      await sendToAgent();
    }
    const rows = deliveries('send_to_agent');
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.outcome)).toEqual(['suppressed', 'suppressed', 'suppressed']);
  });

  it('⚠ RULED 2026-10-06: `TERMINAL_THREAD_CLOSED` is a LOSS — it has no emit site left', async () => {
    // It reads like a protocol bound and is not one. v2.5.34 removed the rejection that raised
    // it, and PHASE-2 T10 (migration 143) then deleted the `is_terminal` flag it was derived
    // from, so the transport cannot raise it on purpose any more. A reason nothing can emit
    // deliberately cannot be "the platform working as designed": if it surfaces, a stale marker
    // went uncleared and the message is gone. Filing it `suppressed` would record a transport
    // bug as intended behaviour — the same class of untruth as the fall-through above.
    deliverSpy.mockResolvedValue(refused('TERMINAL_THREAD_CLOSED'));

    await sendToAgent();

    expect(deliveries('send_to_agent')[0].outcome,
      'a stale closure marker — a transport bug the handler itself calls one — was filed as policy')
      .toBe('failed');
  });

  it('…and the handler already told the agent so, so the ledger and the message now agree', () => {
    // The two halves must not drift: the sentence the agent reads says "engine bug", and the
    // word the ledger records says `failed`. They disagreed before this ruling, which is how a
    // bug could be read as designed behaviour by anyone querying the table instead of the chat.
    const src = fs.readFileSync(path.resolve(HERE, '../agents.ts'), 'utf-8');
    expect(/stale closure marker \(engine bug/.test(src),
      'the handler stopped calling it an engine bug — the ledger word may need re-ruling with it')
      .toBe(true);
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(/A2A_DROPS_THAT_ARE_POLICY[\s\S]{0,200}?TERMINAL_THREAD_CLOSED/.test(stripped),
      'TERMINAL_THREAD_CLOSED is back inside the policy set, against the 2026-10-06 ruling')
      .toBe(false);
  });

  it('an unknown target is `failed` — a real send that could not be made', async () => {
    deliverSpy.mockResolvedValue(refused('AGENT_NOT_FOUND'));

    await sendToAgent();

    const rows = deliveries('send_to_agent');
    expect(rows[0].outcome, 'a send to nobody was filed as a protocol suppression')
      .toBe('failed');
  });

  it('NEITHER refusal can be mistaken for a delivery — the one thing readers filter on', async () => {
    deliverSpy.mockResolvedValue(refused('SEMANTIC_DUPLICATE'));
    await sendToAgent();
    deliverSpy.mockResolvedValue(refused('AGENT_NOT_FOUND'));
    await sendToAgent();

    // Every reader of this table filters `outcome='delivered'`. This is the clause that makes
    // recording refusals safe: it adds rows that answer "did it happen?" with NO, and cannot
    // inflate the count of things that did.
    const asDelivered = deliveries('send_to_agent').filter((r) => r.outcome === 'delivered');
    expect(asDelivered, 'a refusal landed in the delivered set').toEqual([]);
  });

  // ── THE VERIFIER'S DEFECT, and the clause that was missing when it slipped through ────────
  //
  // The first cut of this door allowlisted `failed` for `AGENT_NOT_FOUND` and defaulted every
  // other reason to `suppressed` — the inverse of the sentence written directly above it. The
  // reason union has seven members and that ternary recognised two, so `MALFORMED_ENVELOPE` and
  // `PERSIST_SKIPPED` were both filed as the platform working as designed. `PERSIST_SKIPPED`'s
  // own doc says the receiver's row persisted nothing, so there is no message to deliver: a
  // message that vanished, recorded as a protocol decision.
  //
  // WHY THE SUITE MISSED IT. §2 above drove the four reasons the handler's switch NAMES and the
  // one unknown target, and every one of them was mapped correctly. Nothing drove a reason the
  // ternary did not recognise, so the defect sat in the gap between "the cases I thought of" and
  // "the cases the type allows". The table below is keyed on the SHARED UNION rather than on a
  // list I write here, which is the only shape that closes that gap — and the clause after it
  // fails if the union grows a member this table has not ruled on.
  const HONEST_WORD: Record<string, 'suppressed' | 'failed'> = {
    // Policy: a live refusal the transport makes ON PURPOSE. Two the sender already holds the
    // explanation for, one that is the protocol's own bound. These three are the whole of it.
    SEMANTIC_DUPLICATE: 'suppressed',
    AWAITING_REPLY: 'suppressed',
    HOP_LIMIT_EXCEEDED: 'suppressed',
    // Losses: a message that did not arrive and was not refused on purpose.
    AGENT_NOT_FOUND: 'failed',
    MALFORMED_ENVELOPE: 'failed',     // ⇐ was `suppressed`: the verifier's fall-through defect
    PERSIST_SKIPPED: 'failed',        // ⇐ was `suppressed`: the verifier's fall-through defect
    TERMINAL_THREAD_CLOSED: 'failed', // ⇐ was `suppressed`: ruled 2026-10-06, see the clause below
  };

  it('⚠ EVERY reason in the union is filed under its honest word, not just the ones the switch names', async () => {
    for (const [reason, want] of Object.entries(HONEST_WORD)) {
      deliverSpy.mockResolvedValue(refused(reason));
      await sendToAgent();
    }
    const got = deliveries('send_to_agent').map((r) => r.outcome);
    expect(got, 'a drop is filed under the wrong word — the record lies about why nothing arrived')
      .toEqual(Object.values(HONEST_WORD));
  });

  it('a reason the door does not recognise is a LOSS, never policy — the default direction', async () => {
    // The safe direction, and the one the transport already chose for this same vocabulary: an
    // unrecognised future reason is a failure until somebody argues otherwise. A door that
    // defaults to `suppressed` quietly absorbs the next real loss, which is exactly what
    // happened to `PERSIST_SKIPPED`.
    deliverSpy.mockResolvedValue(refused('A_REASON_INVENTED_BY_A_LATER_TASK'));
    await sendToAgent();
    expect(deliveries('send_to_agent')[0].outcome,
      'an unknown drop reason was filed as the platform working as designed').toBe('failed');
  });

  it('a refusal with NO stated reason at all is a loss too', async () => {
    deliverSpy.mockResolvedValue({ delivered: false, threadId: THREAD });
    await sendToAgent();
    expect(deliveries('send_to_agent')[0].outcome).toBe('failed');
  });

  it('the table above rules on the WHOLE shared union — a new reason cannot arrive unruled', async () => {
    // BOTH DIRECTIONS. The table is a list in a test file, so on its own it would go stale
    // silently: a seventh reason added to the union would simply never be driven, which is the
    // precise failure mode that hid the defect this section exists for. Keyed off the shipped
    // type, a new member reds HERE and forces a decision rather than defaulting into a word
    // nobody chose.
    const src = fs.readFileSync(
      path.resolve(HERE, '../../../../../../shared/src/a2a-protocol.ts'), 'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const union = src.match(/export type A2ADropReason =([\s\S]*?);/);
    expect(union, 'the drop-reason union moved — this clause lost its subject').toBeTruthy();
    const members = [...union![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(members.length, 'the union parsed empty').toBeGreaterThanOrEqual(6);
    // `AWAITING_REPLY` is the local addition on top of the shared union (`A2ADropReasonLocal`),
    // so it is ruled on above but is not expected in the shared type.
    const unruled = members.filter((m) => !(m in HONEST_WORD));
    expect(unruled, 'a drop reason exists that this door has never ruled on — it would default silently')
      .toEqual([]);
  });

  it('a refused send writes NO tool receipt, so the two ledgers still agree', async () => {
    // The receipt is written only on the delivered arm, and that is correct — it is a
    // grounding claim ("I told X"). The delivery ledger records the attempt either way. The
    // clause pins that the fix did not start minting receipts for sends that never landed.
    deliverSpy.mockResolvedValue(refused('SEMANTIC_DUPLICATE'));
    await sendToAgent();
    expect(receipts('send_to_agent'), 'a refused send now claims grounding').toEqual([]);
  });
});

// ── §3 — the second sender the census found ───────────────────────────────────────────────

describe('§3 the group fan-out records every hop it actually made', () => {
  it('⚠ FOUND BY §4: a broadcast writes one row per delivered member', async () => {
    await broadcastToGroup();

    const rows = deliveries('broadcast_to_group');
    // Two other agents in the fictional group; the sender is excluded by the handler's own
    // query. Each gets a FRESH thread, so this is genuinely N deliveries rather than one.
    expect(rows.length, 'the fan-out recorded nothing, or folded N hops into one').toBe(2);
    expect(rows.every((r) => r.outcome === 'delivered')).toBe(true);
    expect(rows.every((r) => r.agent_id === SENDER)).toBe(true);
    expect(rows.map((r) => r.recipient_id).sort()).toEqual([TARGET, 'tyndo'].sort());
  });

  it('one row per RECEIPT, one-for-one — the fan-out cannot drift between its two ledgers', async () => {
    await broadcastToGroup();
    expect(deliveries('broadcast_to_group').length).toBe(receipts('broadcast_to_group').length);
  });
});

// ── §4 — the census: the next receiptless sender reds ─────────────────────────────────────

describe('§4 a door that claims a send records it', () => {
  const SRC = path.resolve(HERE, '../agents.ts');
  const code = () => fs.readFileSync(SRC, 'utf-8')
    // Comments first, always: this file argues the closure in several paragraphs, and a
    // clause satisfiable by that prose would be testing the prose.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  /** Every tool this door writes a SEND receipt for: a receipt carrying `sentText` is a claim
   *  that words were delivered to somebody, which is exactly the claim the ledger exists to
   *  back. Derived from the source, never listed here — a hard-coded list is how the next
   *  sender gets forgotten. */
  const claimedSends = (src: string): string[] => {
    const names = new Set<string>();
    for (const m of src.matchAll(/writeToolReceipt\(\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\)/g)) {
      const body = m[1];
      if (!/sentText:/.test(body)) continue;      // not a claim about words sent to a person
      const tool = body.match(/tool:\s*'([^']+)'/);
      if (tool) names.add(tool[1]);
    }
    return [...names].sort();
  };

  /** Every tool this door records a DELIVERED outcome for.
   *
   *  ⚠ THE OUTCOME IS PART OF THE REQUIREMENT, and leaving it out left a hole big enough to
   *  walk the original defect back through: a first cut of this census matched any
   *  `recordAtDoor` carrying the tool's name, and stayed GREEN with the delivered-arm write
   *  deleted — because this door also records REFUSALS for the same tool, and a refusal row
   *  is not a receipt for a hand-off that happened. Caught by the mutant, not by review. The
   *  claim being audited is "words reached somebody", so only a `delivered` record answers it. */
  const recorded = (src: string): string[] => {
    const names = new Set<string>();
    // ⚠ BRACE-MATCHED, NOT NON-GREEDY (verifier's second note). The obvious
    // `recordAtDoor\(\{([\s\S]*?)\}\)` truncates at the FIRST `})` inside the call, and the
    // broadcast site's `detail: \`A2A ${bcIntent} (group ${groupId})\`` contains exactly that
    // sequence. It happened to work only because `outcome` and `tool` both precede `detail` at
    // both call sites — i.e. the census depended on field ORDER nobody had agreed to keep.
    // Reordering two keys would have silently emptied it, which is the quiet-vacuity failure a
    // census is supposed to be immune to. Counting depth is cheap and removes the coupling.
    for (const m of src.matchAll(/recordAtDoor\(\{/g)) {
      const start = m.index! + m[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) continue;
      const body = src.slice(start, end);
      if (!/outcome:\s*'delivered'/.test(body)) continue;
      const tool = body.match(/tool:\s*'([^']+)'/);
      if (tool) names.add(tool[1]);
    }
    return [...names].sort();
  };

  it('the census parser is not coupled to field ORDER inside the call', () => {
    // The guard for the hardening above: `detail` carries a literal `})` at the broadcast site,
    // so a non-greedy matcher reads a truncated body. Proven on the real source rather than a
    // fixture — if the parser ever regresses to non-greedy, the delivered-outcome filter starts
    // missing whichever call puts `detail` before `outcome` and the census quietly empties.
    const src = code();
    expect(/detail: `A2A \$\{bcIntent\} \(group \$\{groupId\}\)`/.test(src),
      'the `})`-bearing detail string moved — this hardening may no longer have a subject')
      .toBe(true);
    expect(recorded(src), 'the parser lost a recorded door')
      .toEqual(['broadcast_to_group', 'send_to_agent']);
  });

  it('non-vacuity: the door really does claim sends, and the parser really finds them', () => {
    // A census over a corpus that has quietly stopped containing its subject passes for ever.
    const claims = claimedSends(code());
    expect(claims.length, 'the parser found no send claims — this section lost its subject')
      .toBeGreaterThanOrEqual(2);
    expect(claims, 'the lane\'s own subject is not among the claims').toContain('send_to_agent');
  });

  it('⚠ THE CENSUS: every send this door claims is also recorded in the delivery ledger', () => {
    const src = code();
    const claims = claimedSends(src);
    const rows = recorded(src);
    // SET COMPARISON, both directions implied: a tool that claims a send and records nothing
    // is E3 again under a new name, and this is the clause that reds for it. No exemptions —
    // writing this is what surfaced `broadcast_to_group`, and it was fixed rather than listed.
    const unrecorded = claims.filter((t) => !rows.includes(t));
    expect(unrecorded,
      'a tool claims it sent words to somebody and writes no delivery row — this is E3\'s shape, in a new sender')
      .toEqual([]);
  });

  it('the ledger is reached through the ONE door recorder, never by a second writer', () => {
    const src = code();
    // `recordAtDoor` folds into an open outbound scope rather than standing beside that
    // scope's row; a handler calling `recordDelivery` directly would double-count the piece
    // delivery it supersedes, and would also bypass the ask-settlement unit.
    expect(/recordDelivery\(/.test(src), 'the door grew a second ledger writer').toBe(false);
    expect(/recordAtDoor\(/.test(src), 'the door stopped recording deliveries at all').toBe(true);
  });

  it('the recorded outcome is read from the transport\'s answer through the ONE decider', () => {
    const src = code();
    // The honesty requirement in source form: the refusal arm's outcome is DERIVED from
    // `result.reason`, and derived by the named decider rather than by an expression at the
    // call site. That is not style — the inline ternary that stood here is what inverted its
    // own comment and filed two real losses as policy, because a condition written at the call
    // site is a condition nobody can test apart from the send.
    expect(/outcome:\s*a2aDropOutcome\(result\.reason\)/.test(src),
      'the refusal arm stopped deriving its outcome from the transport\'s stated reason')
      .toBe(true);
  });

  it('the decider ALLOWLISTS policy and DEFAULTS to loss — the direction, pinned in source', () => {
    const src = code();
    // The behavioural table in §2 pins today's seven reasons. This pins the SHAPE that keeps
    // the eighth safe: membership of a named set earns `suppressed`, and everything else —
    // unrecognised, absent, future — is `failed`. An allowlist of failures with a `suppressed`
    // default is the exact defect the verifier caught, and it would pass §2 unchanged on the
    // day a new reason is added.
    expect(/A2A_DROPS_THAT_ARE_POLICY\s*:\s*ReadonlySet/.test(src),
      'the policy set stopped being a declared vocabulary').toBe(true);
    expect(/A2A_DROPS_THAT_ARE_POLICY\.has\(reason\)\s*\?\s*'suppressed'\s*:\s*'failed'/.test(src),
      'the decider inverted: a drop reason now has to be recognised to be called a FAILURE, so the next unknown loss is filed as policy')
      .toBe(true);
  });
});
