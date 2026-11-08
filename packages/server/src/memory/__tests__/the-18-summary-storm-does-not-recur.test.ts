// ════════════════════════════════════════════════════════════════════════════════════════
// THE #18 SUMMARY STORM DOES NOT RECUR — a two-hour replay of the report's own shape.
//
// THE REPORT (GitHub issue #18, its anonymised telemetry): in two hours one agent's memory writer ran
// 41 times (`request_type memory_summarize`), many calls with output at or above input (723 → 1,102;
// 13,775 → 16,888; 26,109 → 23,854), beside main-model calls of about 44K to 110K tokens (a fixed ~43.9K
// prefix) and about twenty turns. Eighteen of the writer calls came back to back on inputs of 370-900 tokens.
//
// THE FIXES THIS PINS TOGETHER (t268 / t269): a summary is written whole from what the writer was shown; history
// is folded once per level (no re-condensing of a note); the target is sized by the writer's own token density; a
// cut-off summary is never kept; thinking is off for summary jobs; a span the writers refuse is marked and not
// re-tried every pass. Each has its own file. THIS file asks the question the owner asked: with the report's shape
// run through the real doors for two simulated hours, is the storm gone?
//
// THE SHAPE: twenty turns over two hours, every one an agent-to-agent hand-off in its own thread; nineteen model calls
// (the output sizes of the report's `heavy` calls, its tool mix and result sizes; one long turn of six tool calls); a
// 44K prefix; a 128K window; and, behind the window, a backlog of thirty-odd small threads (the report's run of tiny
// writer calls is a fold across threads like these: a note is written about ONE conversation).
//
// WHAT IS REAL: the migrated DB; the engine's own sequence per model call (the assembly door
// `assembleWithNothingOutOfViewUnsummarised`, the gate's placeholder replacer and routine `checkAndCompact` on the
// rows the view says are leaving, and two forced passes as an overflow door runs them); the assembler's gauge; the
// condenser; the summary DAG; the writer choice and its health; AND `callModel` itself, so the request
// each summary job really sends (the thinking switch, the output room, a retry's room) is what the writer sees.
// WHAT IS FAKE: only the provider, as a local HTTP stub (the wire the t269 thinking test uses), and the clock
// (`Date` only: the stub advances it by the time a real writer would have taken). The stub behaves like #18's
// writer: it answers long (its length follows the INPUT, not the target it is given; sometimes up to half again
// the input), it pads a tiny input to a few hundred tokens, it stops at the `max_tokens` it was sent and says
// `length`, and, unless the request switches thinking off, it spends 41% of its output on reasoning (the share
// the investigation measured) and reports it in `usage`. It obeys an explicit "write it again in about N tokens"
// (a real model does, mostly), so a rewrite can succeed.
//
// The accuracy check on a finished summary is another lane's subject (`writeThenCheck` is passed through) and is
// not a summary call.
//
// THE ASSERTIONS (all on the same run):
//   (1) every kept summary is shorter than its input;
//   (2) the writer calls are bounded by the rows that left the view, at every point of the two hours.
//       THE ARITHMETIC. L = rows covered by a note (the rows that left the view). A leaf job covers at least one
//       row no other note covers, so the leaf notes number at most L; a merge removes at least one top-level note
//       (two or more notes become one), so the merges number at most (leaf notes - 1); the notes the writer wrote
//       are therefore at most 2L - 1. A job either stores a note or is a logged refusal (`SUMMARY_REFUSED`), and a
//       refusal is not retried (the span is split or marked). One job costs at most four writer calls (`writeWhole`:
//       the answer, its cut retry, the sized rewrite, its cut retry). So calls <= 4 x ((2L - 1) + refusals), a bound
//       that grows with the rows that left and with nothing else, in particular not with the number of passes;
//   (3) no span is summarised twice: no row is in two leaf notes; no input is dialled in two separate jobs; a note
//       is the child of at most one merge, and only of notes one level down (history folded once per level), so a
//       row has passed through the writer at most once per level and a leaf note at most 1 + log2(leaf notes) times;
//   (4) no cut-off summary is stored (a whole summary ends with its closing section; a cut one does not).
// The same file was run against the base before t269 (the commit before 3a5d12b7); its report quotes both.
//
// All fixture names and text are invented.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-the-18-storm', 'dojo.db'),
  };
});
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-the-18-storm');
  return { homeDir: (): string => dir, dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs), isTestRun: (): boolean => true };
});
interface LogLine { level: string; message: string; meta: Record<string, unknown> }
const logLines: LogLine[] = [];
vi.mock('../../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger.js')>();
  const at = (level: string) => (message: string, meta?: Record<string, unknown>): void => { logLines.push({ level, message, meta: meta ?? {} }); };
  return { ...actual, createLogger: () => ({ debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }) };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../gateway/routes/services.js', () => ({ recordProviderError: vi.fn(), recordProviderSuccess: vi.fn() }));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));
const prefix = vi.hoisted(() => ({ toolPayloadTokens: 1000 }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => prefix.toolPayloadTokens }));
vi.mock('../../agent/local-model-fit.js', async (orig) => ({ ...(await orig<object>()), freeWriterWindowTokens: async () => Number.MAX_SAFE_INTEGER }));   // the small writer's free-memory gate: not this file's subject
vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));
vi.mock('../summary-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../summary-check.js')>();
  return { ...actual, writeThenCheck: (p: unknown, write: (p: unknown) => unknown) => write(p) };   // the accuracy check: another lane's subject
});

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache, setProviderCredential } from '../../config/loader.js';
import { clearClientCache } from '../../agent/model.js';
import { insertMessage } from '../message-store.js';
import { assembleContext } from '../assembler.js';
import { assembleWithNothingOutOfViewUnsummarised } from '../out-of-view.js';
import { checkAndCompact, estimateAssembledTokens, leavingFromView, NO_CONVERSATION_PLACEHOLDER } from '../compaction.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { __resetSummaryWriterHealthForTests } from '../writer.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';
import { __resetEstimateCacheForTests } from '../assembled-estimate-cache.js';
import { replacePlaceholdersInBackground } from '../out-of-view.js';
import { backgroundDrains } from '../../agent/shared-state.js';
import { estimateTokens } from '../budget.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-the-18-storm', '.dojo');
const AGENT = 'agent-the-18';
const MAIN = 'm-main';       // the agent's own model: a 128K window (its calls peak at ~110K)
const PEER = 'agent-the-18-peer';

// ── the report's shape, in numbers read off its telemetry ─────────────────────────────────
const TWO_HOURS_MS = 120 * 60_000;
/** The fixed prefix every main call carries (the report's cache read floor: 43,904 tokens). */
const PREFIX_TOKENS = 43_904;
/** The main model's window: the report's biggest main call is ~110K. */
const WINDOW = 128_000;
/** What the writer's request may hold at most before it says `length` when nothing asks for more (the 16,384 cap the investigation found). */
const DEFAULT_OUTPUT_CAP = 16_384;
/** The share of its output the writer spends reasoning when its request leaves thinking on (investigation H6: ~41%). */
const REASONING_SHARE = 0.41;
/** The writer's answers as a share of its input: 'about as long as the input', sometimes half again (report: 26,109 → 23,854, 13,775 → 16,888, 723 → 1,102). */
const LENGTH_HABIT = [1.0, 0.92, 1.2, 1.5, 0.9, 1.1];
/** A tiny input still gets a few hundred tokens of boilerplate (report: 372 → 834, 461 → 2,328). */
const PADDING_FLOOR_TOKENS = 600;
/** The main model's own output sizes, in the order of the report's `heavy` calls (its `output_tokens`). */
const HEAVY_OUTPUTS = [1877, 1422, 1786, 101, 3933, 4096, 4096, 4096, 3621, 1498, 4059, 4096, 4096, 3724, 2448, 4096, 4096, 3000, 2200];
/** The tool results of the report's tempo, in order: errors are short, a web fetch is long. Tokens. */
const RESULT_TOKENS = [350, 350, 2600, 9000, 1800, 7000, 8200, 3000, 1200, 400, 8200, 2400, 500, 1800, 3000, 600, 2000, 700, 900];
const TOOL_NAMES = ['exec', 'exec', 'exec', 'web_fetch', 'exec', 'exec', 'work_update', 'dojo_report', 'send_to_agent', 'work_update', 'web_fetch', 'exec', 'work_update', 'exec', 'dojo_report', 'work_update', 'exec', 'dojo_report', 'work_update'];
/** The report: 20 turns and 19 model calls; the one long turn made six tool calls. Turns that make no model call are
 *  hand-offs that only arrive (their rows are small and sit in their own threads). */
const MODEL_CALLS_PER_TURN = [0, 1, 1, 6, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 0];
/** Two overflow doors fire in the two hours (a provider says "too long"): the forced pass runs as the recovery runs it. */
const FORCED_AT_ITERATION = new Set([8, 15]);
/** The history the agent already carries when the two hours begin: many small hand-off threads of a line or two each (the
 *  report's eighteen back-to-back writer calls on inputs of 370-900 tokens are a fold across threads like these). */
const SEED_THREADS = 32;

// ── the fake provider: a local stub on the wire, behaving like #18's writer ──────────────
interface WriterCall {
  job: number; at: number; depth: number; inputKey: string; inputTokens: number; outputTokens: number; reasoningTokens: number;
  stop: string; maxTokens: number; thinking: boolean; rewrite: boolean; asked: boolean; text: string;
}
let calls: WriterCall[] = [];
/** How this writer sizes its first answer: 'long' (the report's: about as long as its input, whatever it is told), or
 *  'follows' (it aims at the length it is told, and overshoots by up to 60%): the best case for the new prompts. */
let writerKind: 'long' | 'follows' = 'long';
let stub: http.Server;
let stubUrl = '';
let habit = 0;
let job = 0;
const FILLER = ['the owner asked about the shipment', 'the agent checked the ledger and replied', 'the reply was filed under the matching order', 'a follow-up was scheduled for the next review',
  'the report named the carrier and the dock', 'the task was updated with the result', 'the figures were confirmed against the invoice', 'the thread was handed to the other agent'];
const FACT = /\b[A-Z]{2,5}-\d{3,6}\b/g;

/** Text of about `tokens` tokens (4 characters each), carrying `facts` and ending with the closing section a whole summary has. */
function summaryText(facts: readonly string[], tokens: number): string {
  const closing = '\nRESOLVED: everything above is closed.';
  const head = `Summary of the span.\nFacts: ${facts.join(', ')}\n`;
  const chars = Math.max(tokens * 4, head.length + closing.length);
  let body = head;
  for (let i = 0; body.length < chars - closing.length; i += 1) body += `${FILLER[i % FILLER.length]}. `;
  return `${body.slice(0, chars - closing.length)}${closing}`;
}

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        messages: Array<{ role: string; content: string }>; max_tokens?: number; max_completion_tokens?: number; thinking?: { type?: string };
      };
      const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      const inputTokens = estimateTokens(user);
      const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_OUTPUT_CAP;
      const thinking = body.thinking?.type !== 'disabled';
      // how long it would write: about as long as the INPUT (never as the target it was given)...
      let natural = Math.max(PADDING_FLOOR_TOKENS, Math.round(inputTokens * LENGTH_HABIT[habit++ % LENGTH_HABIT.length]));
      // ...unless it is told, in so many words, how long to write it again (the rewrite note)
      const target = /Target approximately (\d+) tokens/.exec(system);
      if (writerKind === 'follows' && target) natural = Math.max(40, Math.round(Number(target[1]) * [0.8, 1.0, 1.3, 1.6][habit % 4]));
      const told = /Write it again from the input in about (\d+) tokens/.exec(system) ?? /the target is (\d+) tokens\. Cut ruthlessly/.exec(system);
      if (told) natural = Math.max(40, Math.round(Number(told[1]) * 1.1));
      const reasoning = thinking ? Math.round(natural * REASONING_SHARE / (1 - REASONING_SHARE)) : 0;
      const room = Math.max(0, maxTokens - reasoning);
      const cut = natural > room;
      const facts = [...new Set(user.match(FACT) ?? [])];
      const whole = summaryText(facts, natural);
      const text = cut ? whole.slice(0, Math.max(0, room * 4)) : whole;
      const outputTokens = Math.min(maxTokens, reasoning + estimateTokens(text));
      const depthMatch = [...user.matchAll(/<summary id="[^"]*" depth="(\d+)"/g)].map((m) => Number(m[1]));
      const asked = maxTokens > DEFAULT_OUTPUT_CAP;
      if (!told && !asked) job += 1;   // a new summary job starts with an answer asked for plainly; a rewrite and a retry with room belong to the job before
      calls.push({
        job, at: Date.now(), depth: depthMatch.length > 0 ? Math.max(...depthMatch) + 1 : 0, inputKey: crypto.createHash('sha1').update(user).digest('hex'),
        inputTokens, outputTokens, reasoningTokens: reasoning, stop: cut ? 'length' : 'stop', maxTokens, thinking, rewrite: Boolean(told), asked, text,
      });
      // a real writer takes time: ~25 ms per output token plus a second to start
      vi.setSystemTime(Date.now() + 1000 + outputTokens * 25);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown): string => sse({
        id: 'c-the-18', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
      });
      if (reasoning > 0) res.write(chunk({ role: 'assistant', reasoning_content: 'thinking '.repeat(Math.min(50, Math.ceil(reasoning / 2))) }));
      for (let i = 0; i < text.length; i += 8_000) res.write(chunk({ role: 'assistant', content: text.slice(i, i + 8_000) }));
      res.write(chunk({}, cut ? 'length' : 'stop'));
      res.write(sse({ id: 'c-the-18', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [],
        usage: { prompt_tokens: inputTokens + estimateTokens(system), completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens, completion_tokens_details: { reasoning_tokens: reasoning } } }));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;
});
afterAll(async () => { await new Promise<void>((r) => stub.close(() => r())); });

// ── the box ────────────────────────────────────────────────────────────────────────────────
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 19, 6, 0, 0));
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  clearClientCache();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, behaves_like, is_validated, created_at, updated_at)
             VALUES ('p-ds', 'Writer Cloud', 'openai-compatible', ?, 'api_key', 'deepseek-native', 1, datetime('now'), datetime('now'))`).run(stubUrl);
  d.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
             VALUES ('p-main', 'Main Cloud', 'openai-compatible', 'http://127.0.0.1:1/v1', 'api_key', 1, datetime('now'), datetime('now'))`).run();
  const model = d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, thinking_enabled, thinking_level, is_enabled, created_at, updated_at)
                           VALUES (?, ?, ?, ?, '["text","thinking","tools"]', ?, ?, 1, 'high', 1, datetime('now'), datetime('now'))`);
  // v3.5 field fix 3 (edited: the writer was a separate model picked in Settings, as in #18's report): the owner ruled
  // there is no summarization setting and each agent's own model writes its summaries, so the agent's own model is
  // the stub writer here (its provider), at its own 128K window. Nothing else about the shape moves.
  model.run(MAIN, 'p-ds', 'Main', 'main-model', WINDOW, DEFAULT_OUTPUT_CAP);
  d.prepare("INSERT INTO agents (id, name, model_id, status, config, session_started_at, created_at, updated_at) VALUES (?, 'Replay Agent', ?, 'idle', '{}', '1970-01-01', datetime('now'), datetime('now'))").run(AGENT, MAIN);
  d.prepare("INSERT INTO agents (id, name, model_id, status, config, session_started_at, created_at, updated_at) VALUES (?, 'Peer Agent', ?, 'idle', '{}', '1970-01-01', datetime('now'), datetime('now'))").run(PEER, MAIN);
  setProviderCredential('p-ds', 'sk-writer', 'api_key');
  calls = [];
  gate.checked = 0;
  gate.compacted = 0;
  elapsedMs = 0;
  samples.length = 0;
  rowNo = 0;
  turnNo = 0;
  habit = 0;
  job = 0;
  logLines.length = 0;
  prefix.toolPayloadTokens = 1000;
  __resetBrakesForTests();
  __resetBreakersForTests();
  __resetEstimateCacheForTests();
  __resetSummaryWriterHealthForTests();
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

// ── the tempo ─────────────────────────────────────────────────────────────────────────────
let rowNo = 0;
const WORDS = ['ledger', 'carrier', 'invoice', 'dock', 'manifest', 'reply', 'review', 'quote', 'order', 'depot', 'pallet', 'route'];
/** `tokens` tokens of ordinary prose carrying one order id (so there are facts to keep). */
function prose(tokens: number, tag: string): string {
  let s = `${tag} order ORD-${1000 + rowNo} for ${100 + (rowNo % 90)}.00: `;
  for (let i = 0; s.length < tokens * 4; i += 1) s += `${WORDS[(i * 7 + rowNo) % WORDS.length]} ${WORDS[(i * 3 + 1) % WORDS.length]}, `;
  return s.slice(0, tokens * 4);
}
let turnNo = 0;
/** The report's turns are all agent-to-agent hand-offs, each its own thread (`turn kind a2a`, `exit handoff`), so a fold
 *  writes one note per thread: that is what makes many writer calls out of few rows. */
let thread = 'thr-0';
function userRow(tokens: number): void {
  rowNo += 1; turnNo += 1;
  thread = `thr-${turnNo}`;
  insertMessage({
    agentId: AGENT, role: 'user', lane: 'a2a', content: `[A2A:REPORT thread:${thread} from:Peer] ${prose(tokens, 'Please look at')}`,
    sourceAgentId: PEER, a2aThreadId: thread, a2aIntent: 'REPORT', a2aRequiresResponse: false, turnNumber: turnNo,
  });
}
function toolStep(i: number, outTokens: number, resultTokens: number): void {
  rowNo += 1;
  const id = `call-${rowNo}`;
  insertMessage({
    id: `a-${rowNo}`, agentId: AGENT, role: 'assistant', turnNumber: turnNo, subjectKind: 'a2a_thread', a2aThreadId: thread,
    content: JSON.stringify([{ type: 'text', text: prose(Math.max(20, outTokens - 80), 'Checked') }, { type: 'tool_use', id, name: TOOL_NAMES[i % TOOL_NAMES.length], input: { argv: ['run', `job-${rowNo}`] } }]),
  });
  insertMessage({
    id: `r-${rowNo}`, agentId: AGENT, role: 'tool', turnNumber: turnNo, subjectKind: 'a2a_thread', a2aThreadId: thread,
    content: JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: prose(resultTokens, 'Result') }]),
  });
}

/** The gate's first step before a model call: placeholders are replaced first, in the background, when a writer is answering
 *  (`replacePlaceholdersInBackground`, the gate's own launcher); here the replacement is awaited. Then the routine check is measure-only. */
async function placeholdersFirst(): Promise<boolean> {
  const replacing = replacePlaceholdersInBackground(AGENT);
  while (backgroundDrains.has(AGENT)) await new Promise<void>((r) => setImmediate(r));
  return replacing;
}

/** The gate's routine check before a model call (context-gates.ts `condenseForTheDialedModel` → `condenseLeavingInBackground`), awaited. */
const gate = { checked: 0, compacted: 0 };
let elapsedMs = 0;
async function routineGate(): Promise<void> {
  const { view } = await estimateAssembledTokens(AGENT, WINDOW, MAIN);
  const leaving = leavingFromView(view);
  gate.checked += 1;
  if (leaving || view.summaryRawTokens > view.summaryTokens) {
    gate.compacted += 1;
    await checkAndCompact(AGENT, MAIN, WINDOW, { leaving, dialedModelId: MAIN, inTheBackground: true });
  }
}

interface Sample { t: number; callsSoFar: number; rowsLeft: number; refusals: number; mainCallTokens: number }
const samples: Sample[] = [];
/** Rows that have left the live view: covered by a note (a summary's rows, or a placeholder's, or a kept-whole row's). */
function rowsLeft(): number {
  return (db().prepare('SELECT COUNT(DISTINCT sm.message_id) AS n FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id WHERE s.agent_id = ?').get(AGENT) as { n: number }).n;
}

async function runTwoHours(): Promise<void> {
  // the history the agent already carries, written before the window opens
  const start = Date.now();
  vi.setSystemTime(start - 3 * 3_600_000);
  for (let n = 0; n < SEED_THREADS; n += 1) {
    userRow(230 + ((n * 53) % 260));
    rowNo += 1;
    insertMessage({ id: `s-${rowNo}`, agentId: AGENT, role: 'assistant', turnNumber: turnNo, subjectKind: 'a2a_thread', a2aThreadId: thread, content: prose(250 + ((n * 71) % 200), 'Replied') });
    vi.setSystemTime(Date.now() + 5 * 60_000);
  }
  vi.setSystemTime(start);
  // fixed prefix: the system prompt the assembler counts plus the tool payload, to the report's 43,904
  prefix.toolPayloadTokens = 1000;
  const sys = (await estimateAssembledTokens(AGENT, WINDOW, MAIN)).view.systemTokens;
  prefix.toolPayloadTokens = Math.max(0, PREFIX_TOKENS - sys);
  __resetEstimateCacheForTests();

  let iteration = 0;
  for (let t = 0; t < MODEL_CALLS_PER_TURN.length; t += 1) {
    vi.setSystemTime(Math.max(Date.now(), start + Math.round((t * TWO_HOURS_MS) / MODEL_CALLS_PER_TURN.length)));
    userRow(MODEL_CALLS_PER_TURN[t] === 0 ? 60 + ((t * 37) % 90) : 400 + ((t * 137) % 700));   // a hand-off that only arrives is a line or two
    for (let k = 0; k < MODEL_CALLS_PER_TURN[t]; k += 1, iteration += 1) {
      // one model call, in the engine's order (`agent/v2/loop.ts`: the pre-call gates, then the assembly)
      if (!await placeholdersFirst()) await routineGate();
      await assembleWithNothingOutOfViewUnsummarised(AGENT, WINDOW, () => assembleContext(AGENT, MAIN));
      const view = (await estimateAssembledTokens(AGENT, WINDOW, MAIN)).view;
      samples.push({ t: Date.now() - start, callsSoFar: calls.length, rowsLeft: rowsLeft(), refusals: logLines.filter((l) => l.message.startsWith('SUMMARY_REFUSED')).length, mainCallTokens: PREFIX_TOKENS + view.summaryTokens + view.tailKeptTokens });
      if (FORCED_AT_ITERATION.has(iteration)) await checkAndCompact(AGENT, MAIN, WINDOW, { force: true, inTurn: true, dialedModelId: MAIN });
      toolStep(iteration, HEAVY_OUTPUTS[iteration], RESULT_TOKENS[iteration]);
    }
  }
  vi.setSystemTime(Math.max(Date.now(), start + TWO_HOURS_MS));
  elapsedMs = Date.now() - start;
}

// ── reading the run ───────────────────────────────────────────────────────────────────────
interface NoteRow { id: string; depth: number; kind: string; content: string }
const notes = (): NoteRow[] => db().prepare('SELECT id, depth, kind, content FROM summaries WHERE agent_id = ? ORDER BY created_at, rowid').all(AGENT) as NoteRow[];
/** The notes a writer wrote (a placeholder, a kept-whole row and a span holding no conversation are model-free). */
const writerNotes = (): NoteRow[] => notes().filter((n) => (n.kind === 'leaf' || n.kind === 'condensed') && n.content !== NO_CONVERSATION_PLACEHOLDER);
/** The notes this one was merged from. */
const childrenOf = (id: string): string[] => (db().prepare('SELECT parent_id AS c FROM summary_parents WHERE summary_id = ?').all(id) as Array<{ c: string }>).map((r) => r.c);
/** How many merges took this note as an input. */
const mergedInto = (id: string): number => (db().prepare('SELECT COUNT(*) AS n FROM summary_parents WHERE parent_id = ?').get(id) as { n: number }).n;
/** The longest run of merges above a note, plus the note's own job: how many times its rows went through the writer. */
const timesThroughTheWriter = (id: string): number => (db().prepare(`
  WITH RECURSIVE up(id, n) AS (SELECT ?, 1 UNION ALL SELECT sp.summary_id, up.n + 1 FROM summary_parents sp JOIN up ON sp.parent_id = up.id)
  SELECT MAX(n) AS n FROM up`).get(id) as { n: number }).n;
/** The rows a leaf note covers. */
const rowsOf = (id: string): string[] => (db().prepare('SELECT message_id AS m FROM summary_messages WHERE summary_id = ?').all(id) as Array<{ m: string }>).map((r) => r.m);
/** The writer call that produced this text (the last one that did). */
function callThatWrote(text: string): WriterCall | undefined {
  for (let i = calls.length - 1; i >= 0; i -= 1) if (calls[i].text === text) return calls[i];
  return undefined;
}
const refusals = (): number => logLines.filter((l) => l.message.startsWith('SUMMARY_REFUSED')).length;
const WHOLE_ENDING = 'RESOLVED: everything above is closed.';

function report(label: string): void {
  // eslint-disable-next-line no-console
  if (process.env.THE18_CALLS) console.log(calls.map((c, i) => `${i} job${c.job} d${c.depth} in=${c.inputTokens} out=${c.outputTokens} reasoning=${c.reasoningTokens} max=${c.maxTokens} ${c.stop}${c.rewrite ? ' rewrite' : ''}${c.asked ? ' room-asked' : ''}`).join('\n'));
  const sum = (f: (c: WriterCall) => number): number => calls.reduce((t, c) => t + f(c), 0);
  const kinds = Object.fromEntries([...new Set(notes().map((n) => n.kind))].map((k) => [k, notes().filter((n) => n.kind === k).length]));
  // eslint-disable-next-line no-console
  console.log(`THE-18 REPLAY [${label}] ${JSON.stringify({
    writerCalls: calls.length, jobs: job, rowsLeftTheView: rowsLeft(), notes: kinds, deepestNote: Math.max(0, ...notes().map((n) => n.depth)),
    cutByTheOutputLimit: calls.filter((c) => c.stop === 'length').length, rewritesAsked: calls.filter((c) => c.rewrite).length,
    callsWithThinkingOn: calls.filter((c) => c.thinking).length, callsOutputAtOrAboveInput: calls.filter((c) => c.outputTokens >= c.inputTokens).length,
    inputTokens: sum((c) => c.inputTokens), outputTokens: sum((c) => c.outputTokens), reasoningTokens: sum((c) => c.reasoningTokens),
    retriesGivenRoom: calls.filter((c) => c.asked).length, checkAndCompactPasses: logLines.filter((l) => l.message.startsWith('Compaction check:')).length, routineChecks: gate.checked, routineChecksThatFolded: gate.compacted, simulatedMinutes: Math.round(elapsedMs / 60_000), refusalsLogged: refusals(), mainCallTokens: [Math.min(...samples.map((x) => x.mainCallTokens)), Math.max(...samples.map((x) => x.mainCallTokens))],
  })}`);
}

describe.each([['a writer that answers as long as its input, whatever it is told (the report\'s)', 'long'], ['a writer that aims at the length it is told (the best case)', 'follows']] as const)(
  'the #18 summary storm does not recur — %s', (_name, kind) => {
    beforeEach(() => { writerKind = kind; });

    it('replays two hours through the real doors', async () => {
      await runTwoHours();
      report(kind);
      // the run is the report's shape, not an empty one
      expect(Math.max(...samples.map((s) => s.mainCallTokens)), 'the biggest main call reaches the report\'s ~110K range').toBeGreaterThan(95_000);
      expect(Math.min(...samples.map((s) => s.mainCallTokens)), 'and never falls below the fixed prefix').toBeGreaterThan(PREFIX_TOKENS);
      expect(elapsedMs, 'two simulated hours').toBeGreaterThanOrEqual(TWO_HOURS_MS);
      expect(calls.length, 'the writer was called at all').toBeGreaterThan(0);
      expect(writerNotes().length, 'and wrote summaries').toBeGreaterThan(0);
      const left = rowsLeft();
      expect(left, 'rows left the view').toBeGreaterThan(30);
      if (kind === 'long') {
        // non-vacuity: this writer really answered long, was really cut, and was really asked again with room
        expect.soft(calls.filter((c) => c.outputTokens >= c.inputTokens).length, 'answers at or above their input').toBeGreaterThan(5);
        expect.soft(calls.filter((c) => c.stop === 'length').length, 'answers cut by the output limit').toBeGreaterThan(0);
        expect.soft(calls.filter((c) => c.asked).length, 'retries given more room (a feature of the fixed base)').toBeGreaterThan(0);
      }

      // (1) every kept summary is shorter than its input
      const unmatched: string[] = [];
      const notShorter: string[] = [];
      for (const n of writerNotes()) {
        const c = callThatWrote(n.content);
        if (!c) { unmatched.push(`${n.id} ${n.kind} d${n.depth}: ${JSON.stringify(n.content.slice(0, 200))}`); continue; }
        if (estimateTokens(n.content) >= c.inputTokens) notShorter.push(`${n.kind} d${n.depth}: kept ${estimateTokens(n.content)} tokens from an input of ${c.inputTokens}`);
      }
      expect.soft(unmatched, 'every kept note is a writer answer').toEqual([]);
      expect.soft(notShorter, '(1) kept summaries not shorter than their input').toEqual([]);

      // (2) the writer calls are bounded by the rows that left, at every point (the arithmetic is in the header)
      const leafNotes = writerNotes().filter((n) => n.kind === 'leaf').length;
      expect.soft(leafNotes, 'leaf notes <= rows left').toBeLessThanOrEqual(left);
      expect.soft(writerNotes().length, 'notes written <= 2L - 1').toBeLessThanOrEqual(2 * left - 1);
      const perJob = new Map<number, number>();
      for (const c of calls) perJob.set(c.job, (perJob.get(c.job) ?? 0) + 1);
      expect.soft(Math.max(0, ...perJob.values()), 'a job costs at most four calls').toBeLessThanOrEqual(4);
      const bound = (rows: number, refused: number): number => 4 * (Math.max(0, 2 * rows - 1) + refused);
      expect.soft(calls.length, `(2) ${calls.length} calls against 4 x ((2 x ${left} - 1) + ${refusals()} refusals) = ${bound(left, refusals())}`).toBeLessThanOrEqual(bound(left, refusals()));
      for (const s of samples) expect.soft(s.callsSoFar, `at ${Math.round(s.t / 60_000)} min: ${s.callsSoFar} calls, ${s.rowsLeft} rows left`).toBeLessThanOrEqual(bound(s.rowsLeft, s.refusals));
      // and the jobs are the notes plus the refusals: nothing else dials the writer
      expect.soft(job, `(2) ${job} jobs against ${writerNotes().length} notes + ${refusals()} refusals`).toBeLessThanOrEqual(writerNotes().length + refusals());

      // (3) no span is summarised twice
      const seenRows = new Set<string>();
      const twice: string[] = [];
      for (const n of writerNotes().filter((x) => x.kind === 'leaf')) for (const m of rowsOf(n.id)) { if (seenRows.has(m)) twice.push(m); seenRows.add(m); }
      expect.soft(twice, '(3) rows covered by two leaf notes').toEqual([]);
      const jobsPerInput = new Map<string, Set<number>>();
      for (const c of calls) jobsPerInput.set(c.inputKey, (jobsPerInput.get(c.inputKey) ?? new Set<number>()).add(c.job));
      expect.soft([...jobsPerInput.values()].filter((j) => j.size > 1).length, '(3) inputs dialled in two separate jobs').toBe(0);
      const mergedTwice = writerNotes().filter((n) => mergedInto(n.id) > 1).map((n) => n.id);
      expect.soft(mergedTwice, '(3) notes taken into two merges').toEqual([]);
      const wrongLevel = writerNotes().filter((n) => n.kind === 'condensed').flatMap((n) => childrenOf(n.id).map((c) => ({ n, c })))
        .filter(({ n, c }) => (notes().find((x) => x.id === c)?.depth ?? -1) !== n.depth - 1).map(({ n }) => `${n.id} d${n.depth}`);
      expect.soft(wrongLevel, '(3) merges of notes from different levels (a deep note re-folded with new ones)').toEqual([]);
      const allowed = 1 + Math.floor(Math.log2(Math.max(1, leafNotes)));
      const passes = writerNotes().filter((n) => n.kind === 'leaf').map((n) => timesThroughTheWriter(n.id));
      expect.soft(Math.max(...passes), `(3) a row went through the writer ${Math.max(...passes)} times; the most for ${leafNotes} leaf notes is ${allowed}`).toBeLessThanOrEqual(allowed);

      // (4) no cut-off summary is stored
      const cutTexts = new Set(calls.filter((c) => c.stop === 'length').map((c) => c.text));
      expect.soft(writerNotes().filter((n) => cutTexts.has(n.content)).length, '(4) stored summaries that are a cut-off answer').toBe(0);
      expect.soft(writerNotes().filter((n) => !n.content.endsWith(WHOLE_ENDING)).length, '(4) stored summaries without their closing section').toBe(0);
    });
  },
);
