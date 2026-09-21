// T83 — A TURN'S TRIGGER SURVIVES ASSEMBLY.
//
// ── THE INCIDENT (first random-scenario gated run, seed 42e6ff7617b5, idx3 delegation,
//    behav-sig:a9ca4fea, dojo.log 2026-09-20T23:21:34.111Z) ──
//
// A freshly spawned A2A worker (BehavWorker) answers its ASSIGN via `send_to_agent`
// (a DELIVERABLE) and exits its loop. `close-the-loop.ts::scheduleCompletionReport`
// inserts an engine event (`lane='events'`, `origin_intent='completion_report'`) so the
// owner — who never saw the peer-to-peer reply — gets told, and queues a wakeup. The
// runtime's own unserved-wake drain finds that SAME event still pending at turn-end and
// queues an immediate re-run (`head: "e:77299"`). That re-run's own context assembly
// logged:
//
//   error memory-assembler  Context assembly produced 0 messages after filtering,
//   recovering last user message  {agentId: a9ca4fea-...}
//
// ── ROOT CAUSE, TRACED ROW BY ROW (the dev DB's actual rows for a9ca4fea, seqs
//    77295/77298/77299) ──
//
// `scopeToEngineTurn` (this file) correctly keeps the completion-report row (it is
// `origin.kind === 'engine'`). But the AWARENESS PARTITION right after it — the block
// that splits `scopedTail` into `freshTail` (live) and `awarenessEvents` (gisted) — pulls
// EVERY engine-origin `role==='user'` row out of the live tail unless its id equals
// `turnContext.engineEventKeepFullId`. That field was computed in
// `agent/v2/steps/assemble/index.ts` ONLY when `pendingEngineEvent.originIntent ===
// 'a2a_request'` — so a `completion_report` trigger (structurally identical: it is
// ALSO the reason this turn exists, per `engine-riders.ts`'s own "deliverable event"
// list, which names "a peer's completion report" beside "an a2a request") got swept
// into the gist instead.
//
// On a normal agent with real conversation history that would just be a wasted gist.
// On THIS freshly spawned worker, the only other rows in its short life are its own
// prior tool call (`send_to_agent`) and that call's tool_result — both role-shifted to
// `{role:'user', content:[...tool_result...]}` by `tailRender`. With the trigger swept
// away, `freshTail` = [assistant(tool_use), user(all-tool_result)]. `applyIntegrityPass`'s
// "must start with role=user" repair then shifts BOTH off (an assistant lead, then an
// all-tool_result user lead — Anthropic allows neither as the first message), landing
// at zero. Assembly's own empty-guard fires the error above and recovers via an
// UNSCOPED "last user message in the DB" query — which happened, by luck of recency
// ordering, to be this very row. That is a lucky recovery, not a structural guarantee:
// the fix is to stop the awareness partition from ever taking the row in the first
// place, exactly as `T10`/`T68b` already did for `scopeToA2AThread`'s fan-out compile
// order (`a-compile-order-the-model-can-see.test.ts`, same shape, different scoper).
//
// THE FIX (`agent/v2/steps/assemble/index.ts`): `engineEventKeepFullId` is now set
// whenever `isEngineTurn && pendingEngineEvent` — ANY pending engine event driving a
// turn, not one hand-picked intent. `getPendingEngineEvent`'s own query excludes every
// `ENGINE_RIDER_INTENTS` value, so `pendingEngineEvent` can never be a rider — the
// broadened rule cannot leak a steer/hint into "kept full" status; it can only ever
// point at the one deliverable row that IS this turn's reason for existing.
//
// This file tests the MECHANISM at the layer the fix and the bug both live in: given
// the exact row shape the incident produced, and the `engineEventKeepFullId` value the
// FIXED `runAssemble` now computes for it, does the real assembler (`assembleContext`,
// unmocked) produce a non-empty message array carrying the trigger? The companion test
// in `agent/v2/steps/assemble/__tests__/contract.test.ts` proves `runAssemble` itself
// computes that id correctly for a `completion_report` (and any other non-rider) intent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

vi.mock('../../tools/tool-docs.js', () => ({
  measureAgentToolPayloadTokens: async () => 1000,
}));

vi.mock('../../agent/model.js', () => ({
  callModel: async () => ({ content: 'x', toolCalls: [], usage: {} }),
  getContextWindow: () => CONTEXT_WINDOW,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

vi.mock('../vector-search.js', () => ({
  vectorSearch: async () => [],
}));

import { assembleContext } from '../assembler.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t83-behavworker';
const MODEL = 'model-t83';
const CONTEXT_WINDOW = 200000;
const T0 = Date.parse('2026-09-20T23:21:30Z');

/** Fingerprints — a token the platform itself put in the bytes, so "did it arrive" is a
 *  substring test on the platform's own output, never a reading of prose. */
const TRIGGER_FP = 'COMPLETION-REPORT-TRIGGER-FINGERPRINT-6f11';
const AMBIENT_FP = 'STALE-SCHEDULER-NOTICE-FINGERPRINT-3a09';
const A2A_REQUEST_FP = 'A2A-REQUEST-APPROVAL-TOKEN-FINGERPRINT-88cd';

let tseq = 0;

function insertRow(p: {
  id: string; role: string; content: string; lane: 'owner' | 'a2a' | 'events';
  originIntent?: string | null;
}): void {
  tseq += 1;
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at, origin_intent)
     VALUES (?, ?, ?, ?, ?, ?, ?, 2, 'live', 1, ?, ?, ?)`,
  ).run(
    p.id, AGENT, p.role, p.lane, p.content,
    p.lane === 'events' ? 'engine-note' : p.lane === 'a2a' ? 'a2a' : (p.role === 'assistant' ? 'agent-text' : 'user-text'),
    p.lane === 'owner' ? 'user-visible' : 'agent-only',
    Math.max(1, Math.ceil(p.content.length / 4)), T0 + tseq * 1000, p.originIntent ?? null,
  );
}

/** The incident's own shape: a freshly spawned agent whose entire recorded life, at the
 *  moment its completion-report engine event fires, is its own prior tool call. */
function seedTheFreshSpawnShape(triggerOriginIntent: string, triggerFp: string): string {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:8000/v1')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'ds4-local', 'DS4', ?, 4096, '["tools","thinking"]', 1)`,
  ).run(MODEL, CONTEXT_WINDOW);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, ?, 'idle', ?, '{}')")
    .run(AGENT, 'T83Worker', MODEL);

  // The agent's own prior turn: it answered its ASSIGN with send_to_agent, then a tool
  // result confirming delivery — the exact JSON shapes `dojo.db` held on the real
  // incident row (seqs 77295 / 77298), renamed to generic ids.
  insertRow({
    id: 't83-assistant-tool-use', role: 'assistant', lane: 'a2a',
    content: JSON.stringify([
      { type: 'tool_use', id: 'call_send', name: 'send_to_agent',
        input: { agent: 'BehaviorBot', intent: 'DELIVERABLE', thread_id: 'thread-abc', payload: 'the answer' } },
    ]),
  });
  insertRow({
    id: 't83-tool-result', role: 'tool', lane: 'a2a',
    content: JSON.stringify([
      { type: 'tool_result', tool_use_id: 'call_send', is_error: false,
        content: '[A2A:DELIVERABLE] Message delivered to "BehaviorBot" on thread thread-abc.' },
    ]),
  });

  const triggerId = 't83-trigger';
  insertRow({
    id: triggerId, role: 'user', lane: 'events', originIntent: triggerOriginIntent,
    content:
      `[Engine event: ${triggerOriginIntent}] You just finished work the owner asked for while you were ` +
      `talking to another agent, so they have not seen the result yet: [${triggerFp}]. Send the owner ONE ` +
      `short completion note. If there is genuinely nothing worth telling them, reply with [no-reply].`,
  });
  return triggerId;
}

const textOf = (msgs: Array<{ content: unknown }>): string =>
  msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

beforeEach(() => {
  tseq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T83 §1 — REPRODUCTION: the incident shape, driven at the real assembler', () => {
  it('RED-BY-CONSTRUCTION: without the keep-full id (the pre-fix gate\'s outcome for a non-a2a_request intent), the LIVE tail collapses to zero and the assembler falls back', async () => {
    seedTheFreshSpawnShape('completion_report', TRIGGER_FP);

    // This IS what the OLD `assemble/index.ts` computed for a `completion_report`
    // trigger: `engineEventKeepFullId` stays null because its gate only recognised
    // `a2a_request`. Driving the real assembler at that value reproduces the incident
    // mechanically, not just by narration.
    //
    // NOTE ON THE ASSERTION SHAPE: `assembleContext` never RETURNS an empty array — its
    // own empty-context guard (`memory/assembler.ts`, the fallback this incident's log
    // line names) recovers a message before returning, which is exactly why the incident
    // self-recovered instead of crashing. `lane.fresh-tail` itself still reports
    // `admitted` in the allocation report at this point: the SWEPT tail it rendered (the
    // agent's own tool_use/tool_result pair, 2 messages) was genuinely non-empty when
    // THAT lane ran — the trigger was already gone by then, gisted away one step
    // earlier. It is `applyIntegrityPass`'s "must start with role=user" repair, run on
    // the COMBINED array afterwards, that strips a leading assistant message and then a
    // leading all-tool_result message and lands at zero — invisible to any per-lane
    // grant, and visible only in the one place the code itself records "I had to
    // recover": the fallback message's own lane tag.
    const ctx = await assembleContext(AGENT, MODEL, { isEngineTurn: true, engineEventKeepFullId: null });

    expect(ctx.messageEntryIds).toContain('lane.empty-context-fallback');
  });

  it('GREEN: with the keep-full id the FIXED gate now computes for ANY pending engine event, the trigger survives as LIVE tail content — no fallback needed', async () => {
    const triggerId = seedTheFreshSpawnShape('completion_report', TRIGGER_FP);

    const ctx = await assembleContext(AGENT, MODEL, { isEngineTurn: true, engineEventKeepFullId: triggerId });

    expect(ctx.messageEntryIds).not.toContain('lane.empty-context-fallback');
    expect(ctx.messages.length).toBeGreaterThan(0);
    expect(textOf(ctx.messages)).toContain(TRIGGER_FP);
  });

  it('GREEN, regression control: the ORIGINAL exemption (an a2a_request intent) still keeps full — the broadened rule is a strict superset, not a replacement', async () => {
    const triggerId = seedTheFreshSpawnShape('a2a_request', A2A_REQUEST_FP);

    const ctx = await assembleContext(AGENT, MODEL, { isEngineTurn: true, engineEventKeepFullId: triggerId });

    expect(ctx.messages.length).toBeGreaterThan(0);
    expect(textOf(ctx.messages)).toContain(A2A_REQUEST_FP);
  });
});

describe('T83 §2 — CONTROL: the fix does not widen what the awareness lane gists', () => {
  it('an AMBIENT engine notice that is NOT this turn\'s own pending event still gets swept out of the live tail', async () => {
    const triggerId = seedTheFreshSpawnShape('completion_report', TRIGGER_FP);
    // A stale, already-queued notice from earlier in the session — real ambient
    // awareness, and not the row driving this turn.
    insertRow({
      id: 't83-ambient-notice', role: 'user', lane: 'events', originIntent: 'scheduler',
      content: `[Scheduler] the 6pm garbage reminder fired and was delivered. [${AMBIENT_FP}]`,
    });

    const ctx = await assembleContext(AGENT, MODEL, { isEngineTurn: true, engineEventKeepFullId: triggerId });

    // The trigger still survives in full (the fix held)...
    expect(textOf(ctx.messages)).toContain(TRIGGER_FP);
    // ...but the ambient row's fingerprint is NOT in the live conversation array: it did
    // not get a free pass just because SOME row on this turn is now exempt.
    expect(textOf(ctx.messages)).not.toContain(AMBIENT_FP);
    // It is exactly where T68b's charter says an ordinary engine notice belongs: gisted,
    // not dropped outright.
    expect(ctx.eventsLane ?? '').toContain('garbage reminder');
  });
});
