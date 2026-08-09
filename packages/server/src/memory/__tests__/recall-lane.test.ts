// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 item 4 — THE MEMORY CORE. `SWEEP-C.md` T4 (per-message recall, owner-decided
// GO 2026-07-26) plus the owner's 2026-08-09 incident: his agent RE-INVESTIGATED a question
// it had already answered.
//
// EVERY CLAUSE BELOW FAILS AT THIS TASK'S BASE COMMIT `d07c2aa`, and they fail for two
// different reasons, which is the point:
//
//   • §1-§2 (THE POSITION AND THE BUDGET) fail because `lane.relevant-memory` was a
//     `fitLanes` candidate at `MessageSlot.RelevantMemory = 400` — AHEAD of the fresh tail
//     (1100) and of the volatile boundary `msg.turn-context` (1850) — while its CONTENT was
//     already re-derived from the live ask on every turn (`buildPerTurnRecallQuery`). That is
//     precisely the shape SWEEP-C T4's cache-prefix rider names: "a lane whose content
//     changes with the live ask CANNOT sit at its current position". It had no reserve of its
//     own, no derived worst case and no `truncate` that any input could ever reach.
//
//   • §3-§5 (THE CONCLUSION) fail because the lane recalled RAW ROWS and nothing else. A
//     similarity hit on an old question surfaced THE QUESTION; the answer the agent had
//     already given was a different row that had to win the same search on its own merits,
//     and nothing ever tied the two together. `engine.recently-answered`
//     (`agent/v2/steps/call-llm/pre-call-injections.ts`) knew the right key —
//     `messages.answer_message_id`, migration 113 — but it is scoped to ONE conversation and
//     it renders the QUESTION EXCERPT ONLY, while telling the model "a brief restatement of
//     the answer's content is fine". The content was never in the block. Across a session or
//     conversation boundary the block is empty outright. So the agent could be told it had
//     answered something and be given no way to say what — and re-doing the work is the
//     rational response to that prompt.
//
// THE KEY IS THE LEDGER'S, NEVER PROSE. Every pairing clause here is driven through
// `messages.answer_message_id` — the completion-truth stamp `agent/v2/answered-edge.ts` owns
// — and §5 holds that shut structurally.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-recall-lane-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  RECALL_LANE, RECALL_LANE_ID, RECALL_LANE_ENTRY_ID,
  renderRecallLane, truncateRecallLane, recallLaneWorstCaseTokens,
  type RecallLaneContext, type RecallLanePayload,
} from '../recall-lane.js';
import {
  LANE_LIMITS, LANE_PRIORITY, LANE_SECTION_LABEL, LANE_LADDER_LABEL,
  POST_BUDGET_LANES, POST_BUDGET_ENTRY_LANE, isProtectedLaneId,
  laneLimit, renderScaffoldingAck, type LaneRender,
} from '../lanes.js';
import { MessageSlot } from '../../prompt/registry/types.js';
import { getMessageEntries } from '../../prompt/registry/registry.js';
import '../../prompt/registry/entries.js';
import { answeredPairsForMessages, recentlyAnsweredAsks } from '../../agent/v2/answered-edge.js';
import { engineText, engineFileWithBoth } from '../../agent/v2/__tests__/engine-sources.js';
import { relativeTimeAgo } from '../../agent/v2/outbound-ledger.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const AGENT = 'core2-recall';
const OTHER_AGENT = 'core2-recall-other';
const CONV = 'conv-owner';

let seq = 0;
/** One real `messages` row. Returns its id. */
function seedMessage(p: {
  role: 'user' | 'assistant';
  content: string;
  agentId?: string;
  conversationId?: string | null;
  minutesAgo?: number;
}): string {
  const db = mockDb.current!;
  const id = `m-${++seq}`;
  const at = Date.now() - (p.minutesAgo ?? 10) * 60_000;
  db.prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, p.agentId ?? AGENT, p.conversationId === undefined ? CONV : p.conversationId,
    p.role, p.content, at);
  return id;
}

/** Stamp the completion-truth key: `ask` was answered by `answer` (migration 113). */
function stampAnswer(askId: string, answerId: string): void {
  mockDb.current!.prepare('UPDATE messages SET answer_message_id = ? WHERE id = ?')
    .run(answerId, askId);
}

/** The lane context, with retrieval already done — the render is the subject here. */
function ctxWith(over: Partial<RecallLaneContext> = {}): RecallLaneContext {
  return {
    agentId: AGENT,
    includeVault: false,
    excludeIds: new Set<string>(),
    msgHits: [],
    vaultHits: [],
    alreadyAnsweredAskIds: new Set<string>(),
    ...over,
  };
}

const textOf = (r: LaneRender<RecallLanePayload> | null): string =>
  (r?.messages?.[0]?.content as string | undefined) ?? '';

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  for (const id of [AGENT, OTHER_AGENT]) {
    db.prepare(
      `INSERT INTO agents (id, name, status, session_started_at)
       VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(id, id);
  }
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(CONV, AGENT);
  seq = 0;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE POSITION. Per-turn retrieval rides the TAIL, and 400 is retired.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the recall lane rides the tail', () => {
  it('is a POST-BUDGET lane at a slot PAST the volatile boundary', () => {
    const declared = POST_BUDGET_LANES.find((l) => l.id === RECALL_LANE_ID);
    expect(declared, `${RECALL_LANE_ID} is not declared in POST_BUDGET_LANES`).toBeDefined();
    expect(declared!.slot).toBeGreaterThan(MessageSlot.TurnContext);
    expect(RECALL_LANE.slot).toBe(declared!.slot);
  });

  it('sits between the deliveries lane and peer-status, renumbering nothing', () => {
    expect(RECALL_LANE.slot).toBeGreaterThan(MessageSlot.Deliveries);
    expect(RECALL_LANE.slot).toBeLessThan(MessageSlot.PeerStatus);
  });

  it('MessageSlot 400 is RETIRED, not reused — a per-ask lane may never sit there again', () => {
    const types = read('prompt/registry/types.ts');
    expect(types).not.toMatch(/^\s*RelevantMemory = /m);
    // The number stays retired with its reason, the same discipline TrackerNotif=1500 got.
    expect(types).toMatch(/400[\s\S]{0,400}RETIRED|RETIRED[\s\S]{0,400}400/);
    const slots = Object.values(MessageSlot).filter((v): v is number => typeof v === 'number');
    expect(slots).not.toContain(400);
  });

  it('is no longer a scaffolding lane the ack closes', () => {
    expect(LANE_PRIORITY[RECALL_LANE_ID]).toBeUndefined();
    expect(LANE_SECTION_LABEL[RECALL_LANE_ID]).toBeUndefined();
    expect(LANE_LADDER_LABEL[RECALL_LANE_ID]).toBeUndefined();
  });

  it('THE GOLDEN FIXTURE\'S ACK IS BYTE-UNMOVED (assembled-context.json, cell "baseline")', () => {
    // 419 chars, sha `ace5b4b4…` in `checks/golden/assembled-context.json`. The ack filters by
    // ADMITTED ids and that fixture never admits the recall lane, so dropping the lane's two
    // labels cannot move a byte of it. Pinned here so the golden is not the only thing that
    // would notice.
    const ack = renderScaffoldingAck(['lane.directive', 'lane.fresh-tail']);
    expect(ack).toBe(
      'Understood, I have reviewed my background context (active user directive). Source ' +
      'priority for this turn: active user directive > live conversation below. When sources ' +
      'disagree, trust the most recent and most specific. The active user directive is the ' +
      'WHAT, never lose it. The scratchpad is my own working outline; I maintain it via ' +
      'scratchpad_set as I make progress and read from it when I need to remember where I am.',
    );
    expect(ack!.length).toBe(419);
    expect(ack).not.toContain('relevant memory');
  });

  it('is protected from the repair, and its entry is attributed to it', () => {
    expect(isProtectedLaneId(RECALL_LANE_ID)).toBe(true);
    expect(POST_BUDGET_ENTRY_LANE[RECALL_LANE_ENTRY_ID]).toBe(RECALL_LANE_ID);
  });

  it('the registry entry exists at the declared slot and is injected past the boundary', () => {
    const entry = getMessageEntries().find((e) => e.id === RECALL_LANE_ENTRY_ID);
    expect(entry, `${RECALL_LANE_ENTRY_ID} is not a registered message entry`).toBeDefined();
    expect(entry!.slot).toBe(RECALL_LANE.slot);
    // The injection site sits in the ENGINE — the driver plus its step packages — and the
    // corpus is derived by `engine-sources.ts`, never by a path this file spells (the
    // guard-corpus census refuses a second hand-rolled walk). Reading the ONE engine file
    // that holds all three sites is what makes comparing their positions meaningful: indices
    // across a join measure the order the files were concatenated in, not the order the
    // engine executes.
    const home = engineFileWithBoth(
      `injectRegistryMessage('msg.turn-context'`, `injectRegistryMessage('msg.current-time'`,
    );
    const at = (id: string) => home.text.indexOf(`injectRegistryMessage('${id}'`);
    expect(at(RECALL_LANE_ENTRY_ID)).toBeGreaterThan(-1);
    expect(at('msg.turn-context')).toBeLessThan(at(RECALL_LANE_ENTRY_ID));
    expect(at(RECALL_LANE_ENTRY_ID)).toBeLessThan(at('msg.peer-status'));
  });

  it('ENABLED: no flag can switch per-message recall off (owner decision 2026-07-26)', () => {
    const src = read('memory/recall-lane.ts');
    expect(src).not.toMatch(/getConfig\(|config\.get|FEATURE_|_ENABLED\b/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE BUDGET. Derived from the generator; enforced by a truncate that can be reached.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the reserve is derived and the truncation is real', () => {
  it('the declared reserve IS the generator\'s worst case, not a number beside it', () => {
    const declared = POST_BUDGET_LANES.find((l) => l.id === RECALL_LANE_ID)!;
    expect(declared.reserveTokens).toBe(recallLaneWorstCaseTokens());
    expect(RECALL_LANE.maxTokens).toBe(recallLaneWorstCaseTokens());
    expect(declared.measured).toContain('recallLaneWorstCaseTokens');
  });

  it('no input can exceed the worst case — every cap flooded at once', () => {
    // ⚠ STRENGTHENED after a fault rehearsal. As first written this flooded PAIRS only, so
    // deleting the loose-row cap did NOT make it fail — the bound depends on THREE caps and
    // the clause was exercising one. All three are over-fed here, each well past its cap and
    // each row far longer than its char slice.
    const pairCap = laneLimit(RECALL_LANE_ID, 'rows', 'recallPairs');
    const rowCap = laneLimit(RECALL_LANE_ID, 'rows', 'minTailForRecall');
    const ids: string[] = [];
    for (let i = 0; i < pairCap + 4; i++) {
      const ask = seedMessage({ role: 'user', content: `Q${i} `.repeat(400) });
      const ans = seedMessage({ role: 'assistant', content: `A${i} `.repeat(400) });
      stampAnswer(ask, ans);
      ids.push(ask);
    }
    for (let i = 0; i < rowCap + 10; i++) {
      ids.push(seedMessage({ role: 'user', content: `loose ${i} ${'L'.repeat(2000)}` }));
    }
    const render = renderRecallLane(ctxWith({
      msgHits: ids.map((id) => ({ sourceId: id })),
      includeVault: true,
      vaultHits: Array.from({ length: 20 }, (_, i) => ({ id: `v${i}`, type: 'fact', content: 'x'.repeat(2000) })),
    }));
    expect(render).not.toBeNull();
    expect(render!.tokens).toBeLessThanOrEqual(recallLaneWorstCaseTokens());
    // …and it really did have more to say than it said, so the bound is doing work.
    expect(render!.payload!.pairs).toHaveLength(pairCap);
    expect(render!.payload!.msgLines.length).toBeLessThanOrEqual(rowCap);
  });

  it('truncation shortens, it never empties a lane that has a row', () => {
    // Three pairs, five recalled lines and five vault lines: the whole ladder, so every rung
    // of `truncateRecallLane` is exercised rather than only the last-pair floor.
    const hits: Array<{ sourceId: string }> = [];
    for (let i = 0; i < 3; i++) {
      const ask = seedMessage({ role: 'user', content: `question number ${i} ${'q'.repeat(280)}` });
      const ans = seedMessage({ role: 'assistant', content: `conclusion ${i} ${'a'.repeat(200)}` });
      stampAnswer(ask, ans);
      hits.push({ sourceId: ask });
    }
    for (let i = 0; i < 5; i++) {
      hits.push({ sourceId: seedMessage({ role: 'user', content: `loose line ${i} ${'x'.repeat(280)}` }) });
    }
    const render = renderRecallLane(ctxWith({
      msgHits: hits, includeVault: true,
      vaultHits: Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, type: 'fact', content: 'v'.repeat(290) })),
    }))!;
    for (const budget of [900, 500, 300, 200]) {
      const shrunk = truncateRecallLane(render, budget);
      expect(shrunk.tokens).toBeLessThanOrEqual(budget);
      expect(shrunk.tokens).toBeLessThan(render.tokens);
      expect(textOf(shrunk).length).toBeGreaterThan(0);
      expect(shrunk.payload!.cut).toBe(true);
      // The CONCLUSIONS are the last thing to go: a budget that killed them while a vault line
      // survived would have the ladder upside down.
      if (shrunk.payload!.vaultLines.length > 0) expect(shrunk.payload!.pairs.length).toBe(3);
    }
    // And below the floor it refuses to grow: a "truncation" that costs more than it saves is
    // not one, so the lane hands back what it was given rather than a bigger array.
    const impossible = truncateRecallLane(render, 12);
    expect(impossible.tokens).toBeLessThanOrEqual(render.tokens);
    expect(textOf(impossible).length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE CONCLUSION. The owner's incident: recall carries what the agent ALREADY ANSWERED.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 recall surfaces the conclusion, not just the question', () => {
  it('a hit on an ANSWERED ask carries the answer the agent gave', () => {
    const ask = seedMessage({ role: 'user', content: 'Which of these part codes is the odd one out?' });
    const ans = seedMessage({ role: 'assistant', content: 'BEETLE-9001 is the odd one out.' });
    stampAnswer(ask, ans);
    const text = textOf(renderRecallLane(ctxWith({ msgHits: [{ sourceId: ask }] })));
    expect(text).toContain('odd one out');
    expect(text).toContain('BEETLE-9001');
    expect(text).toMatch(/already answered/i);
  });

  it('a hit on the ANSWER carries the question it answered — the edge walks both ways', () => {
    const ask = seedMessage({ role: 'user', content: 'Which of these part codes is the odd one out?' });
    const ans = seedMessage({ role: 'assistant', content: 'BEETLE-9001 is the odd one out.' });
    stampAnswer(ask, ans);
    const text = textOf(renderRecallLane(ctxWith({ msgHits: [{ sourceId: ans }] })));
    expect(text).toContain('BEETLE-9001');
    expect(text).toContain('odd one out');
  });

  it('the pair renders ONCE even when both halves win the search', () => {
    const ask = seedMessage({ role: 'user', content: 'Which of these part codes is the odd one out?' });
    const ans = seedMessage({ role: 'assistant', content: 'BEETLE-9001 is the odd one out.' });
    stampAnswer(ask, ans);
    const render = renderRecallLane(ctxWith({
      msgHits: [{ sourceId: ask }, { sourceId: ans }],
    }))!;
    expect(render.payload!.pairs).toHaveLength(1);
    const text = textOf(render);
    expect(text.split('BEETLE-9001').length - 1).toBe(1);
  });

  it('NEGATIVE CONTROL: an UNANSWERED ask still recalls, and claims no answer', () => {
    const ask = seedMessage({ role: 'user', content: 'Can you look into the invoice discrepancy?' });
    const render = renderRecallLane(ctxWith({ msgHits: [{ sourceId: ask }] }))!;
    expect(textOf(render)).toContain('invoice discrepancy');
    expect(textOf(render)).not.toMatch(/already answered/i);
    expect(render.payload!.pairs).toHaveLength(0);
  });

  it('rows already in the assembled tail are never re-quoted — paired OR loose', () => {
    // ⚠ STRENGTHENED after a fault rehearsal. As first written this clause seeded only the
    // PAIRED shape, and deleting the `excludeIds` filter at the top of the loop did NOT make
    // it fail: the pair branch has a second `excludeIds` check of its own, so the clause was
    // passing through the wrong door. The LOOSE row — a hit with no answer stamp — is the one
    // with a single guard, and it is the one that leaks a tail row back into recall.
    const ask = seedMessage({ role: 'user', content: 'Which of these part codes is the odd one out?' });
    const ans = seedMessage({ role: 'assistant', content: 'BEETLE-9001 is the odd one out.' });
    stampAnswer(ask, ans);
    expect(renderRecallLane(ctxWith({
      msgHits: [{ sourceId: ask }], excludeIds: new Set([ask]),
    }))).toBeNull();

    const loose = seedMessage({ role: 'user', content: 'a loose unanswered line about widgets' });
    expect(renderRecallLane(ctxWith({ msgHits: [{ sourceId: loose }] }))).not.toBeNull();
    expect(renderRecallLane(ctxWith({
      msgHits: [{ sourceId: loose }], excludeIds: new Set([loose]),
    }))).toBeNull();
  });

  it('an ask `engine.recently-answered` already names is not quoted TWICE', () => {
    const ask = seedMessage({ role: 'user', content: 'Which of these part codes is the odd one out?' });
    const ans = seedMessage({ role: 'assistant', content: 'BEETLE-9001 is the odd one out.' });
    stampAnswer(ask, ans);
    const render = renderRecallLane(ctxWith({
      msgHits: [{ sourceId: ask }], alreadyAnsweredAskIds: new Set([ask]),
    }));
    expect(render).toBeNull();
  });

  it('SCOPE IS NOT WIDENED: another agent\'s answered pair never surfaces', () => {
    const ask = seedMessage({ role: 'user', content: 'the odd one out question', agentId: OTHER_AGENT });
    const ans = seedMessage({ role: 'assistant', content: 'BEETLE-9001', agentId: OTHER_AGENT });
    stampAnswer(ask, ans);
    const render = renderRecallLane(ctxWith({ msgHits: [{ sourceId: ask }] }));
    expect(render).toBeNull();
  });

  it('synthetic engine/A2A rows are still excluded from recall', () => {
    const ask = seedMessage({ role: 'user', content: '[A2A:QUESTION thread:ab from:PM] can you ship X?' });
    expect(renderRecallLane(ctxWith({ msgHits: [{ sourceId: ask }] }))).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — ACROSS THE SESSION BOUNDARY. The half `engine.recently-answered` structurally cannot
// reach: it is scoped to one conversation, and a reset opens a new one.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 the conclusion crosses a session boundary', () => {
  it('an answered pair from the PREVIOUS session is still recallable', () => {
    const db = mockDb.current!;
    const ask = seedMessage({
      role: 'user', content: 'Which of these part codes is the odd one out?',
      conversationId: null, minutesAgo: 120,
    });
    const ans = seedMessage({
      role: 'assistant', content: 'BEETLE-9001 is the odd one out.',
      conversationId: null, minutesAgo: 119,
    });
    stampAnswer(ask, ans);
    // The reset: the session boundary moves past both rows, and a new conversation opens.
    db.prepare('UPDATE agents SET session_started_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), AGENT);

    // `engine.recently-answered` looks in THIS conversation, and finds nothing.
    expect(recentlyAnsweredAsks(AGENT, 'conv-session-2', 3)).toHaveLength(0);
    // The recall lane is not session-scoped and carries the conclusion forward.
    const text = textOf(renderRecallLane(ctxWith({ msgHits: [{ sourceId: ask }] })));
    expect(text).toContain('BEETLE-9001');
  });

  it('the pair reader is one statement over the ledger, both directions', () => {
    const ask = seedMessage({ role: 'user', content: 'question text' });
    const ans = seedMessage({ role: 'assistant', content: 'answer text' });
    stampAnswer(ask, ans);
    const pairs = answeredPairsForMessages(AGENT, [ask, ans]);
    expect(pairs.get(ask)?.answerContent).toBe('answer text');
    expect(pairs.get(ans)?.askContent).toBe('question text');
    expect(pairs.get(ask)).toBe(pairs.get(ans));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE KEY IS THE LEDGER'S. Held shut structurally, not by review.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 answeredness is read, never sniffed', () => {
  it('the lane owns no answer-shaped prose test and no second answer query', () => {
    // Comments are STRIPPED before the check: the module header deliberately NAMES the column
    // it does not read, which is the record of where the key lives and must not be the thing
    // that trips the clause (the same strip `prefix-lane-conformance.test.ts` S3 uses).
    const code = read('memory/recall-lane.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('answer_message_id'); // it asks the edge, it does not re-join
    expect(code).toContain('answeredPairsForMessages');
    for (const smell of ['CLOSEOUT', 'looksLikeAnswer', /here('|’)s the/i]) {
      if (typeof smell === 'string') expect(code).not.toContain(smell);
      else expect(code).not.toMatch(smell);
    }
  });

  it('`engine.recently-answered` reads the SAME owner, not its own hand-written join', () => {
    const engine = engineText();
    expect(engine).toContain('recentlyAnsweredAsks');
    expect(engine).not.toContain('answer_message_id IS NOT NULL');
  });

  it('THE DEAD BLOCK: an epoch-ms `messages.created_at` renders a real relative time', () => {
    // ⚠ This is the clause that would have caught the owner's 2026-08-09 incident's mechanism.
    // `messages.created_at` became an INTEGER at migration 131; `relativeTimeAgo` took a
    // SQLite datetime STRING and called `.replace` on it, so `engine.recently-answered` threw
    // on its FIRST row into a swallowing catch and has not rendered since. Measured on the
    // owner's body at `d07c2aa`: 3,181 answered-stamped rows, block built for none.
    const ask = seedMessage({ role: 'user', content: 'a question asked ten minutes ago' });
    const ans = seedMessage({ role: 'assistant', content: 'the answer' });
    stampAnswer(ask, ans);
    const [row] = recentlyAnsweredAsks(AGENT, CONV, 3);
    expect(row).toBeDefined();
    expect(typeof row.askAt).toBe('number'); // the column's real shape, not the old annotation
    // 'recently' is the function's own give-up value — a pass on it would be the swallow again.
    expect(relativeTimeAgo(row.askAt)).toBe('10 minutes ago');
    // And the STRING shape still works: `deliveries.created_at` is TEXT and did not move.
    expect(relativeTimeAgo('2026-01-01 00:00:00')).toMatch(/ago$/);
  });

  it('the declared caps the render obeys are all in the lane table', () => {
    const limits = LANE_LIMITS[RECALL_LANE_ID];
    expect(limits?.rows?.recallPairs).toBeGreaterThan(0);
    expect(limits?.chars?.answerPreview).toBeGreaterThan(0);
  });
});
