// v3.5 C1 — THE NINE REPLY-CLAIM FLOORS ASK ONE DECISION CALL; THE LEDGER STILL DECIDES.
//
// The nine floors that read a reply's own words (spec A1–A9: "no reply needed", "let me pull that",
// "from now on I'll", "still parked", "sent it to <someone>", "haven't sent it", "submitted",
// "saved", "it's recorded as a commitment") each narrow with a regex. C1 asks the decision model the
// nine questions of the spec's R3 in ONE call per reply, alongside the rules:
//   rule   — no decision model, or the owner held the question to the rule: nothing is asked;
//   shadow — the default: the call runs in the background, the rule decides, both are logged;
//            the turn never waits on it;
//   model  — only once B3's policy measured the model better: the floor reads the model's verdict
//            instead of the regex, except inside the measured band, where today's behaviour stands.
//            The ledger (receipt, work row, tool record) still makes the final call.
// Every /v1/systemone call here is a scripted fetch: no real model is asked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
const insertMessageSpy = vi.fn();
vi.mock('../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: (...a: unknown[]) => insertMessageSpy(...(a as [])),
  insertEngineEventIfAbsent: vi.fn(),
}));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'away' }));
/** Every log line the engine writes during a test, by component (fix round 1: outages are logged once). */
const logs: Array<{ component: string; level: string; msg: string; data?: Record<string, unknown> }> = [];
vi.mock('../../../logger.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: (component: string) => {
    const at = (level: string) => (msg: string, data?: Record<string, unknown>) => { logs.push({ component, level, msg, data }); };
    return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  },
}));

import { runMigrations } from '../../../db/migrations.js';
import { STANDARD_DECISION_MODEL } from '../../../services/local-standard.js';
import { __forgetResidencyForTests } from '../../decide.js';
import { recordShadow, recordTruth, __resetShadowRotationForTests } from '../../decision-shadow.js';
import { decide, measuredDecideTimeoutMs } from '../../decide.js';
import { abortInFlight } from '../../shared-state.js';
import { advance, initState, type AgentTurnState } from '../state.js';
import { runPostCallClassify, POST_CALL_CLASSIFY_PHASE, type PostCallClassifyContext } from '../steps/post-call-classify/index.js';
import {
  REPLY_CLAIM_PURPOSE, REPLY_CLAIM_QUESTIONS, replyClaimsTurnId,
  __replyClaimsSettledForTests, __forgetReplyClaimsForTests, type ReplyClaimQuestion,
} from '../reply-claims.js';

const AGENT = 'agent-a';
const BASE = 'http://127.0.0.1:47123';
const db = (): Database.Database => mockDb.current!;

// ── The scripted decision model ──
const calls: Array<Record<string, unknown>> = [];
/** What the model answers per question; a question not named answers `fallbackP`. */
let modelSays: Partial<Record<ReplyClaimQuestion, number>> = {};
let fallbackP = 0.5;
let respond: (body: Record<string, unknown>) => Promise<Response>;
const scripted = async (body: Record<string, unknown>): Promise<Response> => Response.json({
  answers: Object.fromEntries(Object.keys(body.questions as object).map((q) => [q, { noul: modelSays[q as ReplyClaimQuestion] ?? fallbackP }])),
  usage: { input_tokens: 90 },
});

function installDecisionModel(): void {
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(BASE);
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, output_cost_per_m, is_enabled)
    VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 262144, 0, 0, 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
}

/**
 * B3's policy flips `question` to `model` on measured evidence, never on a typed switch: 40 judged
 * turns the model got right at p 0.9 and the rule got wrong, plus 3 the model got wrong at p 0.45 —
 * so the model's whole 95 % range sits above the rule's and its weakest band is [0.4, 0.5).
 */
function proveModel(question: ReplyClaimQuestion): void {
  const seed = (i: number, p: number): void => {
    recordShadow({ purpose: REPLY_CLAIM_PURPOSE, question, turnId: `seed-${question}-${i}`, ruleSaid: false, modelSaid: { type: 'noul', noul: p } });
    recordTruth(`seed-${question}-${i}`, question, true, 'test');
  };
  for (let i = 0; i < 40; i++) seed(i, 0.9);
  for (let i = 40; i < 43; i++) seed(i, 0.45);
}

// ── The step, driven whole ──
const modelResult = (content: string): PostCallClassifyContext['result'] => ({
  content, toolCalls: [] as ToolCall[], inputTokens: 10, outputTokens: 5, stopReason: 'end_turn',
} as unknown as PostCallClassifyContext['result']);

function ctxFor(content: string, over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT,
    turnCtx: {
      agentId: AGENT, kind: 'user', convKey: 'ck-1', conversationId: 'conv-1', servedWork: undefined,
      engineStartAckDeliveredThisTurn: false, deferredDeliveredByAck: false, voiceFillerFired: false,
      goingIdleDetectorRanThisTurn: false, startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
      phoneStreamCallSid: null,
    } as unknown as PostCallClassifyContext['turnCtx'],
    turnNumber: 7,
    db: db(),
    agent: { id: AGENT, name: 'Agent A' } as unknown as PostCallClassifyContext['agent'],
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as PostCallClassifyContext['counterparty'],
    counterpartyIsAgentSender: false,
    chosenConvKey: 'ck-1',
    hasUnansweredUser: true,
    triggerRow: null,
    isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false, mostRecentIsA2A: false,
    mostRecentInbound: undefined, pendingEngineEvent: null, unrepliedAssign: null,
    a2aReplyContext: null, a2aReplyAssignMessageId: null, settledContextWakeTurn: false, waitingConvs: [],
    inboundChannel: 'dashboard', latestUserSource: 'dashboard',
    lastUserMessageContent: 'can you handle the receipt?',
    configuredModelId: 'test-model',
    turnStartedAt: new Date().toISOString(),
    messageId: 'msg-1',
    result: modelResult(content),
    maxToolLoops: 75,
    reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer: vi.fn(), deliverEngineUserAck: vi.fn(async () => undefined),
    persistAndBroadcastSystemRow: vi.fn(), startAckRepliedNow: vi.fn(() => false), stashContinuationIfHuman: vi.fn(),
    ...over,
  } as PostCallClassifyContext;
}

function stateWith(toolResults: Array<{ name: string; isError: boolean; content?: string }> = []): AgentTurnState {
  const base = initState({
    agentId: AGENT, contextWindow: 128_000, isAutoRouted: false, configuredModelId: 'test-model', turnNumber: 7,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'can you handle the receipt?', lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, {
    phase: POST_CALL_CLASSIFY_PHASE, loopCount: 2, modelId: 'test-model',
    toolResults: toolResults.map((r, i) => ({ toolCallId: `tc-${i}`, content: r.content ?? 'ok', ...r })) as AgentTurnState['toolResults'],
  });
}

const REJECTED_SAVE = [{ name: 'vault_remember', isError: true, content: 'REJECTED' }];

/** Everything the step decided that a person or the model could see. */
async function observe(content: string, toolResults: Array<{ name: string; isError: boolean }> = [], over: Partial<PostCallClassifyContext> = {}) {
  insertMessageSpy.mockClear();
  const out = await runPostCallClassify(stateWith(toolResults), ctxFor(content, over));
  const rows = insertMessageSpy.mock.calls.map((c) => c[0] as { role: string; content: string });
  return {
    directive: out.directive,
    reason: out.directive === 'exit' ? out.reason : null,
    fired: out.state.steerQueue.fired.map((e) => ({ floor: e.floor, content: e.content })),
    /** The reply the person was given (its assistant row), or null when it was swallowed. */
    persisted: rows.filter((r) => r.role === 'assistant').map((r) => r.content).pop() ?? null,
    rows: rows.map((r) => `${r.role}:${r.content}`),
  };
}
const fired = (o: { fired: Array<{ floor: string }> }): string[] => o.fired.map((f) => f.floor);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  calls.length = 0;
  logs.length = 0;
  modelSays = {};
  fallbackP = 0.5;
  respond = scripted;
  __forgetResidencyForTests();
  __forgetReplyClaimsForTests();
  __resetShadowRotationForTests();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (!url.endsWith('/v1/systemone')) return Response.json({ models: [] });
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    calls.push(body);
    return respond(body);
  }));
});
afterEach(async () => {
  await __replyClaimsSettledForTests(AGENT);
  vi.unstubAllGlobals();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the nine questions are the spec\'s R3, asked as one set', () => {
  it('there are exactly nine, each a yes/no question about `reply`', () => {
    expect(Object.keys(REPLY_CLAIM_QUESTIONS)).toEqual([
      'declines_to_reply', 'only_promises_to_start', 'standing_promise', 'asserts_board_state',
      'claims_sent_to_third_party', 'denies_having_sent', 'claims_report_delivered', 'claims_saved',
      'claims_commitment_recorded',
    ]);
    for (const q of Object.values(REPLY_CLAIM_QUESTIONS)) {
      expect(q.type).toBe('noul');
      expect(q.instructions).toContain('`reply`');
    }
  });
});

describe('rule: no decision model on this box', () => {
  it('nothing is asked, and the floors decide exactly as before', async () => {
    const o = await observe('Saved that for you.', REJECTED_SAVE);
    expect(o.directive).toBe('continue');
    expect(fired(o)).toContain('failed-save-claim');
    expect(calls).toHaveLength(0);
  });
});

describe('one decision call per reply, however many floors ask', () => {
  it('every floor of the step reads the reply, and the decision model is asked ONCE, all nine together', async () => {
    installDecisionModel();
    const o = await observe('Here is the answer: the receipt total is $432.');
    expect(o.persisted).toBe('Here is the answer: the receipt total is $432.');
    await __replyClaimsSettledForTests(AGENT);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions as object).sort()).toEqual(Object.keys(REPLY_CLAIM_QUESTIONS).sort());
    // The state is R3's: the reply, what the person last said, and this turn's tools.
    expect(Object.keys(calls[0].state as object).sort()).toEqual(['last_user_message', 'reply', 'tool_calls_this_turn']);
  });

  it('the same reply asked about again is answered from the one call; a new reply is a new call', async () => {
    installDecisionModel();
    await observe('Here is the answer.');
    await observe('Here is the answer.');
    await __replyClaimsSettledForTests(AGENT);
    expect(calls).toHaveLength(1);
    await observe('A different reply, after a steer.', [], { messageId: 'msg-2' });
    await __replyClaimsSettledForTests(AGENT);
    expect(calls).toHaveLength(2);
  });

  it('both answers are logged per question: what the rule said and what the model said, keyed by the reply', async () => {
    installDecisionModel();
    fallbackP = 0.2;
    modelSays = { claims_saved: 0.97 };
    await observe('Saved that for you.');
    await __replyClaimsSettledForTests(AGENT);
    const rows = db().prepare('SELECT question, rule_said, model_said, turn_id, agent_id FROM decision_shadow WHERE purpose = ? ORDER BY question')
      .all(REPLY_CLAIM_PURPOSE) as Array<{ question: string; rule_said: string; model_said: string; turn_id: string; agent_id: string }>;
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.turn_id))).toEqual(new Set([replyClaimsTurnId('msg-1')]));
    expect(rows.every((r) => r.agent_id === AGENT)).toBe(true);
    const saved = rows.find((r) => r.question === 'claims_saved')!;
    expect(saved.rule_said).toBe('true');
    expect(JSON.parse(saved.model_said)).toEqual({ type: 'noul', noul: 0.97 });
    expect(rows.find((r) => r.question === 'declines_to_reply')!.rule_said).toBe('false');
  });

  it('a question the owner held to the rule is never asked', async () => {
    installDecisionModel();
    db().prepare("INSERT INTO config (key, value, updated_at) VALUES ('decision_mode.reply_claims.claims_saved', 'rule', datetime('now'))").run();
    await observe('Here is the answer.');
    await __replyClaimsSettledForTests(AGENT);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions as object)).not.toContain('claims_saved');
    expect(Object.keys(calls[0].questions as object)).toHaveLength(8);
  });
});

describe('shadow: byte-identical to the rule, and the turn never waits', () => {
  // Each case is driven twice: with no decision model (rule), and with one that answers the OPPOSITE of
  // every rule (shadow). What the person and the model see must be the same bytes.
  const CASES: Array<{ name: string; reply: string; tools?: Array<{ name: string; isError: boolean }> }> = [
    { name: 'a rejected save claimed as saved', reply: 'Saved that for you.', tools: REJECTED_SAVE },
    { name: 'a commitment claimed with no row', reply: "Noted — I've recorded the commitment to email the roof quote once the address arrives." },
    { name: 'a bare promise to start', reply: 'On it. Let me pull up all your calendars.' },
    { name: 'a prose decline nobody waits on', reply: 'No reply needed here, closing the thread.' },
    { name: 'an ordinary answer', reply: 'Here is the answer: the receipt total is $432.' },
    { name: 'a denial with no receipt', reply: "I haven't sent it yet." },
  ];

  for (const c of CASES) {
    it(`${c.name}`, async () => {
      const ruled = await observe(c.reply, c.tools);
      __forgetReplyClaimsForTests();
      installDecisionModel();
      // The model answers its own way, and not until released: the turn must not wait for it.
      let release!: () => void;
      const answered = new Promise<void>((r) => { release = r; });
      respond = async (body) => {
        await answered;
        const qs = Object.keys(body.questions as object);
        return Response.json({ answers: Object.fromEntries(qs.map((q) => [q, { noul: 0.5 }])), usage: { input_tokens: 9 } });
      };
      const shadowed = await observe(c.reply, c.tools);   // resolves while the model has not answered
      expect(shadowed).toEqual(ruled);
      release();
      await __replyClaimsSettledForTests(AGENT);
      expect(calls).toHaveLength(1);
    });
  }

  it('the opposite verdict, answered at once, still changes nothing', async () => {
    const ruled = await observe('Saved that for you.', REJECTED_SAVE);
    __forgetReplyClaimsForTests();
    installDecisionModel();
    fallbackP = 0.01;   // "no claim of any kind" — the rule said there was one
    const shadowed = await observe('Saved that for you.', REJECTED_SAVE);
    expect(shadowed).toEqual(ruled);
  });
});

describe('model: the floor reads the model\'s verdict outside its measured band; the ledger still decides', () => {
  it('a probability above the band triggers the existing steer where the rule saw nothing', async () => {
    installDecisionModel();
    proveModel('claims_saved');
    modelSays = { claims_saved: 0.95 };
    const reply = "All handled on my side, you won't have to repeat it.";
    const o = await observe(reply, REJECTED_SAVE);
    expect(o.directive).toBe('continue');
    expect(fired(o)).toContain('failed-save-claim');
    expect(calls).toHaveLength(1);
  });

  it('a probability inside the band does nothing: today\'s behaviour stands', async () => {
    installDecisionModel();
    proveModel('claims_saved');
    modelSays = { claims_saved: 0.45 };
    const o = await observe("All handled on my side, you won't have to repeat it.", REJECTED_SAVE);
    expect(fired(o)).not.toContain('failed-save-claim');
  });

  it('a commitment claim only the model saw is asked of the work ledger, and the steer quotes the reply', async () => {
    installDecisionModel();
    proveModel('claims_commitment_recorded');
    modelSays = { claims_commitment_recorded: 0.93 };
    const reply = "Done — you'll hear from me once the address comes in.";
    const o = await observe(reply);
    const steer = o.fired.find((f) => f.floor === 'uncommitted-promise');
    expect(steer?.content).toContain(reply);
  });

  it('a promise to start only the model saw gets the promise floor\'s own steer', async () => {
    installDecisionModel();
    proveModel('only_promises_to_start');
    modelSays = { only_promises_to_start: 0.9 };
    const o = await observe('Sure thing, pulling your calendars together now.');
    expect(fired(o)).toContain('promise-floor');
    expect(o.fired.find((f) => f.floor === 'promise-floor')!.content).toContain('was a promise to start');
  });

  it('a decision call that fails is the rule\'s answer', async () => {
    installDecisionModel();
    proveModel('claims_saved');
    respond = async () => new Response('down', { status: 500 });
    const hit = await observe('Saved that for you.', REJECTED_SAVE);
    expect(fired(hit)).toContain('failed-save-claim');
    __forgetReplyClaimsForTests();
    const miss = await observe("All handled on my side, you won't have to repeat it.", REJECTED_SAVE, { messageId: 'msg-2' });
    expect(fired(miss)).not.toContain('failed-save-claim');
  });

  it('the model can retire the rule\'s documented false positive: a genuine answer that opens with "no response needed"', async () => {
    const reply = 'No response needed on the receipt, your June total is $432.';
    const ruled = await observe(reply);
    expect(ruled.persisted).toBeNull();   // today: the answer is swallowed (the N-2 note in no-reply.ts)
    __forgetReplyClaimsForTests();
    installDecisionModel();
    proveModel('declines_to_reply');
    modelSays = { declines_to_reply: 0.02 };
    const o = await observe(reply);
    expect(o.persisted).toBe(reply);
  });
});

describe('REVIEW FOCUS 5: the model is confidently wrong — the ledger still decides, the model only narrows', () => {
  it('a quoted "no reply needed" inside a reply that delivers content is never swallowed, at any confidence', async () => {
    installDecisionModel();
    proveModel('declines_to_reply');
    modelSays = { declines_to_reply: 0.99 };
    const reply = 'Your June total is $432. The vendor wrote "no reply needed" on the receipt, so I left that thread alone.';
    const o = await observe(reply);
    expect(o.persisted).toBe(reply);
  });

  it('a confident "it claims it saved" with no rejected save on the record steers nothing', async () => {
    installDecisionModel();
    proveModel('claims_saved');
    modelSays = { claims_saved: 0.99 };
    const o = await observe('Saved that for you.');
    expect(fired(o)).not.toContain('failed-save-claim');
  });

  it('a confident "it claims a commitment is recorded" with a row opened this turn steers nothing', async () => {
    installDecisionModel();
    proveModel('claims_commitment_recorded');
    modelSays = { claims_commitment_recorded: 0.99 };
    const o = await observe("You're all set.", [{ name: 'work_open', isError: false }]);
    expect(fired(o)).not.toContain('uncommitted-promise');
  });

  it('a confident "it claims it sent it to someone" names nobody the ledger can be asked about, so nothing fires', async () => {
    installDecisionModel();
    proveModel('claims_sent_to_third_party');
    modelSays = { claims_sent_to_third_party: 0.99 };
    const o = await observe('Done, that went out earlier.');
    expect(fired(o)).not.toContain('ungrounded-claim');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FIX ROUND 1
// ════════════════════════════════════════════════════════════════════════════

describe('fix round 1 (Important 1): a reply\'s cost does not grow with the shadow log', () => {
  /** 20,000 kept rows per question, none judged — what about 1.4k replies a day leave over the 14-day keep. */
  function fillShadowLog(perQuestion: number): void {
    const ins = db().prepare(`INSERT INTO decision_shadow (purpose, question, agent_id, turn_id, rule_said, model_said, created_at)
      VALUES (?, ?, ?, ?, 'false', '{"type":"noul","noul":0.99}', ?)`);
    const now = Date.now();
    db().transaction(() => {
      for (const q of Object.keys(REPLY_CLAIM_QUESTIONS)) for (let i = 0; i < perQuestion; i++) ins.run(REPLY_CLAIM_PURPOSE, q, AGENT, `fill-${q}-${i}`, now);
    })();
  }

  async function oneReplysReads(perQuestion: number): Promise<{ all: number; shadowReads: number }> {
    installDecisionModel();
    fillShadowLog(perQuestion);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    respond = async (body) => { await held; return scripted(body); };
    await observe('A first reply, after boot.', [], { messageId: 'boot' });   // the score is read once, here
    __forgetReplyClaimsForTests();
    const d = db() as unknown as { prepare: (sql: string) => unknown };
    const real = d.prepare.bind(d);
    const seen = { all: 0, shadowReads: 0 };
    d.prepare = (sql: string) => {
      seen.all++;
      if (/decision_shadow/.test(sql) && /^\s*SELECT/i.test(sql)) seen.shadowReads++;
      return real(sql);
    };
    try {
      await observe('Here is the answer: the receipt total is $432.', [], { messageId: 'measured' });
    } finally { d.prepare = real; }
    release();
    return seen;
  }

  it('20,000 shadow rows per question: no read of the shadow log per reply, and the same reads as an empty log', async () => {
    const empty = await oneReplysReads(0);
    await __replyClaimsSettledForTests(AGENT);
    mockDb.current!.close();
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    __forgetReplyClaimsForTests();
    const full = await oneReplysReads(20_000);
    expect(full.shadowReads).toBe(0);
    expect(full.all).toBe(empty.all);
  }, 60_000);

  it('the policy still flips on measured evidence, and a truth written later moves the held score', async () => {
    installDecisionModel();
    modelSays = { claims_saved: 0.95 };
    const reply = "All handled on my side, you won't have to repeat it.";
    const before = await observe(reply, REJECTED_SAVE, { messageId: 'before' });   // the score is read: nothing judged
    expect(fired(before)).not.toContain('failed-save-claim');
    await __replyClaimsSettledForTests(AGENT);
    proveModel('claims_saved');   // truth written AFTER the score was read joins it as it is written
    const after = await observe(reply, REJECTED_SAVE, { messageId: 'after' });
    expect(fired(after)).toContain('failed-save-claim');
  });
});

describe('fix round 1 (Important 2): a waiting reply has a patience, and Stop cuts a queued call', () => {
  /** A background call that sits at the head of the one queue until released (the review's 4,009 ms probe). */
  function holdTheQueue(): { release: () => void; done: Promise<unknown> } {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    respond = async (body) => {
      if ((body.state as Record<string, unknown>).ahead !== undefined) await held;
      return scripted(body);
    };
    const done = decide({ ahead: 'a call already queued' }, { q: { type: 'noul', instructions: 'Is `ahead` a call?' } }, { purpose: 'probe', patienceMs: 60_000, background: true });
    return { release, done };
  }

  it('the reply returns at its patience with the rule\'s answer; the queued call is never sent; the queue moves on', async () => {
    installDecisionModel();
    proveModel('claims_saved');
    modelSays = { claims_saved: 0.95 };   // the model WOULD steer; patience ran out, so the rule (no claim) stands
    const ahead = holdTheQueue();
    await new Promise((r) => setTimeout(r, 20));
    const behind = decide({ behind: 'a later caller' }, { q: { type: 'noul', instructions: 'Is `behind` a call?' } }, { purpose: 'probe-2', patienceMs: 60_000 });
    const reply = "All handled on my side, you won't have to repeat it.";
    const patience = measuredDecideTimeoutMs(
      { reply, last_user_message: 'can you handle the receipt?', tool_calls_this_turn: ['vault_remember'] }, 9)!;
    const started = Date.now();
    const pending = observe(reply, REJECTED_SAVE);
    await new Promise((r) => setTimeout(r, 50));
    const after = decide({ after: 'queued behind the reply' }, { q: { type: 'noul', instructions: 'Is `after` a call?' } }, { purpose: 'probe-3', patienceMs: 60_000 });
    const o = await pending;
    const waited = Date.now() - started;
    expect(fired(o)).not.toContain('failed-save-claim');   // the rule's answer
    expect(waited).toBeGreaterThanOrEqual(patience - 50);   // it waited its patience, counted from when it asked…
    expect(waited).toBeLessThan(patience + 2_000);          // …and no longer, though the call ahead is still held
    expect(calls.filter((c) => Object.keys(c.questions as object).includes('claims_saved'))).toHaveLength(0);   // never sent
    expect(calls.filter((c) => 'after' in (c.state as object))).toHaveLength(0);   // the call behind still waits its turn
    ahead.release();
    expect(await ahead.done).not.toBeNull();
    expect(await behind).not.toBeNull();   // the queue's other callers are unaffected
    expect(await after).not.toBeNull();
  }, 30_000);

  it('the owner\'s Stop releases a reply waiting in the queue at once, with the rule\'s answer', async () => {
    installDecisionModel();
    proveModel('claims_saved');
    modelSays = { claims_saved: 0.95 };
    const ahead = holdTheQueue();
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    const pending = observe('Saved that for you.', REJECTED_SAVE);
    await new Promise((r) => setTimeout(r, 50));
    abortInFlight(AGENT, 'user-stop', { scope: 'all' });
    const o = await pending;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fired(o)).toContain('failed-save-claim');   // the rule's answer
    ahead.release();
    expect(await ahead.done).not.toBeNull();
  });
});

describe('fix round 1 (minors): a call that gives no answer still leaves its rows, and an outage is said once', () => {
  const FAILURES: Array<{ name: string; make: () => (body: Record<string, unknown>) => Promise<Response> }> = [
    { name: 'an HTTP failure', make: () => async () => new Response('down', { status: 500 }) },
    { name: 'a throwing transport', make: () => async () => { throw new Error('socket hang up'); } },
    { name: 'garbage for an answer', make: () => async () => new Response('{"answers": {"claims_saved": "yes"', { status: 200 }) },
  ];
  for (const f of FAILURES) {
    it(`shadow, ${f.name}: byte-identical to the rule, nine rows with no model answer, one outage line`, async () => {
      const ruled = await observe('Saved that for you.', REJECTED_SAVE);
      __forgetReplyClaimsForTests();
      installDecisionModel();
      respond = f.make();
      const shadowed = await observe('Saved that for you.', REJECTED_SAVE);
      expect(shadowed).toEqual(ruled);
      await __replyClaimsSettledForTests(AGENT);
      await observe('A second reply while it is still down.', [], { messageId: 'msg-2' });
      await __replyClaimsSettledForTests(AGENT);
      const rows = db().prepare('SELECT model_said FROM decision_shadow WHERE purpose = ?').all(REPLY_CLAIM_PURPOSE) as Array<{ model_said: string | null }>;
      expect(rows).toHaveLength(18);
      expect(rows.every((r) => r.model_said === null)).toBe(true);
      const outage = logs.filter((l) => l.component === 'reply-claims' && l.level === 'warn');
      expect(outage).toHaveLength(1);
      expect(String(outage[0].data?.failure)).not.toBe('undefined');
    });
  }

  it('model mode: an outage is logged once, not once per reply, and the model answering again is said once', async () => {
    installDecisionModel();
    proveModel('claims_saved');
    respond = async () => new Response('down', { status: 500 });
    await observe('Saved that for you.', REJECTED_SAVE);
    await observe('Saved that again.', REJECTED_SAVE, { messageId: 'msg-2' });
    await observe('And again.', REJECTED_SAVE, { messageId: 'msg-3' });
    expect(logs.filter((l) => l.component === 'reply-claims' && l.level !== 'debug')).toHaveLength(1);
    respond = scripted;
    await observe('Back now.', [], { messageId: 'msg-4' });
    await observe('Still back.', [], { messageId: 'msg-5' });
    expect(logs.filter((l) => l.component === 'reply-claims' && l.level !== 'debug')).toHaveLength(2);
  });
});
