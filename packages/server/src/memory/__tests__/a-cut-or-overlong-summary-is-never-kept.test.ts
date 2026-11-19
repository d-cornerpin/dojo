// ════════════════════════════════════════════════════════════════════════════════════════
// t269 causes 3 and 4 — A CUT-OFF SUMMARY IS NEVER KEPT AS WHOLE; A SUMMARY IS NEVER LONGER THAN ITS INPUT;
// THE TARGET FOLLOWS THE INPUT.
//
// The measured shapes (v35-summary-quality-investigation.md):
//   H3.1  `writeSummary` never read `result.stopReason`: 12 of the 14 stored summaries from calls that
//         ended at the 16,384-token cap end mid-text, without their closing section, and were kept.
//   H3.2  level 3 cut the MIDDLE out of a summary (10 stored condensed notes carry its marker), and
//         level 2 re-summarised the summary rather than the source ("cut ruthlessly").
//   H3.3  the target was fixed ("approximately 5,000 tokens" for a leaf, 6,000 condensed) whatever the
//         input: 445 of 2,156 DeepSeek leaves are longer than their input (median 2.25×).
//
// Driven through `generateSummary`, the one door every summary comes through. The model call is a
// script per provider shape: DeepSeek / OpenAI-compatible (`length`, with the room it was sent and
// the most a retry could be given), Anthropic (`max_tokens`, no room figure), Ollama (`length`, with
// `num_predict` as the room). The accuracy check is passed through: it is another lane's subject.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../summary-check.js', () => ({
  writeThenCheck: (p: unknown, write: (p: unknown) => unknown) => write(p),
  rewriteInstruction: () => '',
}));
// The small writer's free-memory gate (not this file's subject) reads the machine's Ollama: free memory is plenty here.
vi.mock('../../agent/local-model-fit.js', async (orig) => ({ ...(await orig<object>()), freeWriterWindowTokens: async () => Number.MAX_SAFE_INTEGER }));

interface Scripted { content: string; stopReason: string; outputRoom?: { sent: number; ceiling: number }; throws?: true }
const script: Scripted[] = [];
const seen: Array<{ outputRoomAsk?: number; systemPrompt: string; content: string; utilityTargetTokens?: number }> = [];
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { outputRoomAsk?: number; systemPrompt: string; messages: Array<{ content: string }>; utilityTargetTokens?: number }) => {
    seen.push({ outputRoomAsk: p.outputRoomAsk, systemPrompt: p.systemPrompt, content: p.messages[0].content, utilityTargetTokens: p.utilityTargetTokens });
    const next = script.shift() ?? { content: 'unscripted', stopReason: 'end_turn' };
    if (next.throws) throw new Error('provider 503');
    return { content: next.content, toolCalls: [], inputTokens: 0, outputTokens: 0, stopReason: next.stopReason, ...(next.outputRoom ? { outputRoom: next.outputRoom } : {}) };
  },
}));

import { runMigrations } from '../../db/migrations.js';
import { generateSummary } from '../summarize.js';
import { summaryTargetTokens, summaryFacts } from '../summary-target.js';
import { getDepthPrompt } from '../summarize.js';
import { refuseWhatTheWriterCannotHold } from '../writer.js';
import { STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { estimateTokens } from '../budget.js';

const AGENT = 'agent-t269-cut';
const MODEL = 'model-t269-cut';
/** A leaf input of about 5,000 tokens (20,000 characters). */
const INPUT = `[USER · the owner · Oct 1, 2026, 09:00 AM UTC-07:00] ${'please look into the order and the reply. '.repeat(470)} order ORD-1201 for 340.00`;
const CUT = 'The owner asked about order ORD-1201 for 340.00 and the agent replied that the shipm';
const WHOLE = 'The owner asked about order ORD-1201 for 340.00; the agent replied it shipped.\nRESOLVED: order ORD-1201 — shipped.';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Cut', 'idle')").run(AGENT);
  script.length = 0;
  seen.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const write = (content = INPUT, depth = 0) => generateSummary({
  content, depth, targetTokens: summaryTargetTokens(content), agentId: AGENT, modelId: MODEL,
});

describe('t269 cause 3 — a summary cut by the output limit is never kept as whole', () => {
  it('DeepSeek / OpenAI-compatible: a cut with room to grow is written again with that room, and the whole one is kept', async () => {
    script.push({ content: CUT, stopReason: 'length', outputRoom: { sent: 1_000, ceiling: 384_000 } }, { content: WHOLE, stopReason: 'end_turn' });
    const out = await write();
    expect(out.ok && out.text).toBe(WHOLE);
    expect(seen).toHaveLength(2);
    // the room asked is what a keepable summary can need: never more than the input itself
    expect(seen[1].outputRoomAsk).toBe(estimateTokens(INPUT));
  });

  it('DeepSeek / OpenAI-compatible: cut again → not kept; the span is left for a smaller split, reason recorded', async () => {
    script.push({ content: CUT, stopReason: 'length', outputRoom: { sent: 1_000, ceiling: 384_000 } }, { content: CUT, stopReason: 'length', outputRoom: { sent: 5_000, ceiling: 384_000 } });
    const out = await write();
    expect(out.ok).toBe(false);
    expect(!out.ok && out.tooBig).toBe(true);
    expect(!out.ok && out.reason).toMatch(/cut off/i);
  });

  it('Anthropic: `max_tokens` with no more room to give → not kept, one call', async () => {
    script.push({ content: CUT, stopReason: 'max_tokens' });
    const out = await write();
    expect(out.ok).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('Ollama: `length` at its num_predict → written again with the model\'s room, and kept whole', async () => {
    script.push({ content: CUT, stopReason: 'length', outputRoom: { sent: 1_500, ceiling: 32_768 } }, { content: WHOLE, stopReason: 'end_turn' });
    const out = await write();
    expect(out.ok && out.text).toBe(WHOLE);
    expect(seen[1].outputRoomAsk).toBeGreaterThan(1_500);
  });

  it('the middle of a summary is never cut out (level 3 is gone), and a summary is never re-summarised (level 2 is gone)', async () => {
    const long = `${WHOLE}\n${'padding line that says nothing. '.repeat(1200)}`;   // longer than its 5,000-token input
    script.push({ content: long, stopReason: 'end_turn' }, { content: long, stopReason: 'end_turn' });
    const out = await write();
    expect(out.ok).toBe(false);
    for (const s of seen) expect(s.content, 'every attempt reads the SOURCE, never a summary').toBe(INPUT);
    expect(JSON.stringify(out)).not.toContain('tokens truncated');
  });
});

describe('t269 cause 4 — the target follows the input, and a summary is never longer than its input', () => {
  it('the target is proportional to the input, and never larger than it', () => {
    const small = 'The owner asked to move the call to 3pm. The agent did.';
    expect(summaryTargetTokens(small)).toBeLessThanOrEqual(estimateTokens(small));
    const t1 = summaryTargetTokens('word '.repeat(4_000));
    const t2 = summaryTargetTokens('word '.repeat(16_000));
    expect(t2).toBeGreaterThan(t1 * 3);
    expect(t1).toBeLessThan(estimateTokens('word '.repeat(4_000)));
  });

  it('a fact-dense input gets the room to carry its facts', () => {
    const facts = Array.from({ length: 300 }, (_, i) => `INV-${1000 + i}`).join(' ');
    const plain = 'word '.repeat(facts.length / 5);
    expect(summaryTargetTokens(facts)).toBeGreaterThan(summaryTargetTokens(plain));
  });

  it('the prompt asks for the proportional target, not a fixed 5,000', async () => {
    script.push({ content: WHOLE, stopReason: 'end_turn' });
    await write();
    expect(seen[0].systemPrompt).toContain(`Target approximately ${summaryTargetTokens(INPUT)} tokens`);
    expect(seen[0].systemPrompt).not.toContain('Target approximately 5000 tokens');
  });

  it('a summary longer than its input is written again from the source, and the shorter one is kept', async () => {
    const tiny = 'The owner asked to move the call to 3pm on 2026-10-02. The agent moved it.';
    const padded = `${tiny} ${'The agent remains committed to helping with any further requests. '.repeat(10)}`;
    script.push({ content: padded, stopReason: 'end_turn' }, { content: tiny, stopReason: 'end_turn' });
    const out = await write(tiny);
    expect(out.ok && out.text).toBe(tiny);
    expect(seen[1].content).toBe(tiny);
    expect(seen[1].systemPrompt).toMatch(/longer than/i);
  });

  it('…and if the rewrite is still longer than its input, nothing is kept', async () => {
    const tiny = 'The owner asked to move the call to 3pm on 2026-10-02. The agent moved it.';
    const padded = `${tiny} ${'The agent remains committed to helping with any further requests. '.repeat(10)}`;
    script.push({ content: padded, stopReason: 'end_turn' }, { content: padded, stopReason: 'end_turn' });
    const out = await write(tiny);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toMatch(/longer than its input/i);
  });
});

// ── Fix round 1 ──────────────────────────────────────────────────────────────────────────────
/** Two condensed notes in the condenser's own input shape, each holding `facts` codes. */
const merged = (facts: number): string => [0, 1].map((k) => `<summary id="s${k}" depth="1" conversation="the dashboard conversation" earliest="Oct 1" latest="Oct 2">\n`
  + `The owner asked about ${Array.from({ length: facts }, (_, i) => `REF-${k}${String(i).padStart(4, '0')}`).join(', ')}. ${'The agent answered each one in turn. '.repeat(40)}\n</summary>`).join('\n\n');
const mergeWrite = (content: string, modelId = MODEL) => generateSummary({ content, depth: 2, targetTokens: Math.max(1, Math.floor(0.8 * (estimateTokens(content) / 2) / 1.5)), agentId: AGENT, modelId });

describe('t269 fix round 1 — a merge is strictly smaller than its children (ruling 1b)', () => {
  it('a merge answer over (1 − share) of its average child is rewritten, and not kept if still over', async () => {
    const content = merged(10);
    const big = `${'The owner asked and the agent answered at length. '.repeat(Math.ceil(estimateTokens(content) * 0.6 * 4 / 52))}`;
    expect(estimateTokens(big)).toBeLessThan(estimateTokens(content));   // shorter than its input…
    expect(estimateTokens(big)).toBeGreaterThan(0.8 * estimateTokens(content) / 2);   // …but larger than its average child × 0.8
    script.push({ content: big, stopReason: 'end_turn' }, { content: big, stopReason: 'end_turn' });
    expect((await mergeWrite(content)).ok).toBe(false);
  });
});

describe('t269 fix round 1 — the rewrite (review I2)', () => {
  it('a rewrite that throws keeps the first answer, which passed its own size and stop checks', async () => {
    const content = merged(10);
    const first = 'The owner asked about REF-00000 and the agent answered.';   // within its size, but drops facts
    script.push({ content: first, stopReason: 'end_turn' }, { content: '', stopReason: 'end_turn', throws: true });
    const out = await mergeWrite(content);
    expect(out.ok && out.text).toBe(first);
  });

  it('a rewrite whose missing-facts note would not fit the writer\'s window is never sent; the first answer is kept', async () => {
    const content = merged(300);
    const target = Math.max(1, Math.floor(0.8 * (estimateTokens(content) / 2) / 1.5));
    const base = getDepthPrompt(2, target, AGENT);
    mockDb.current!.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-small', 'S', 'openai-compatible', 'api_key')").run();
    mockDb.current!.prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, context_window) VALUES ('m-small', 'p-small', 's', 's', '[\"chat\"]', 1, 4096)").run();
    // The smallest window that holds the input with the base prompt (stepped up by 64 tokens): no room is left for a long note.
    for (let cw = 4096; refuseWhatTheWriterCannotHold('m-small', base, content, AGENT) !== null; cw += 64) {
      mockDb.current!.prepare('UPDATE models SET context_window = ? WHERE id = ?').run(cw + 64, 'm-small');
    }
    const first = 'The owner asked about REF-00000 and the agent answered.';
    script.push({ content: first, stopReason: 'end_turn' }, { content: 'should never be asked', stopReason: 'end_turn' });
    const out = await mergeWrite(content, 'm-small');
    expect(seen).toHaveLength(1);
    expect(out.ok && out.text).toBe(first);
  });
});

describe('t269 fix round 1 — a time range is not a fact a merge must copy (review M3)', () => {
  it('ranges like 09:00–11:30 and 2026-10-14 – 2026-10-18 are not facts; codes and amounts still are', () => {
    const facts = summaryFacts('[2026-10-14 09:00–11:30] The owner paid $400 on order ORD-77 (v3.4.1); 2026-10-14–2026-10-18 and 9:00-17:00.');
    expect(facts).toEqual(['$400', 'ORD-77', 'v3.4.1']);
  });
});

// ── Rebase onto v35 (I4): the writer's own token density, never a fixed 4 ─────────────────────────
describe('t269 I4 — the target and the room are counted at the writer\'s own token density (t268)', () => {
  it('a target is proportional to the input counted at the writer\'s density', () => {
    const plain = 'word '.repeat(2_000);   // 10,000 characters, no facts
    expect(summaryTargetTokens(plain, 2.48)).toBe(Math.ceil(Math.ceil(10_000 / 2.48) * 0.2));
    expect(summaryTargetTokens(plain, 2.48)).toBeGreaterThan(summaryTargetTokens(plain));
  });

  it('on the Dojo\'s writer (B5: 2.48 characters a token), a cut is asked again with the input counted at that density', async () => {
    mockDb.current!.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-ol', 'O', 'ollama', 'none')").run();
    mockDb.current!.prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-std', 'p-ol', 'w', ?, '[\"chat\"]', 1)").run(STANDARD_WRITER_MODEL.tag);
    script.push({ content: CUT, stopReason: 'length', outputRoom: { sent: 1_000, ceiling: 32_768 } }, { content: WHOLE, stopReason: 'end_turn' });
    const out = await generateSummary({ content: INPUT, depth: 0, targetTokens: summaryTargetTokens(INPUT, 2.48), agentId: AGENT, modelId: 'm-std' });
    expect(out.ok && out.text).toBe(WHOLE);
    expect(seen[1].outputRoomAsk).toBe(Math.ceil(INPUT.length / 2.48));
  });
});

