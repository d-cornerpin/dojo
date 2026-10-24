// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18b — A ROW WHOSE BULK IS NOT TEXT IS NEVER FORCED IN WHOLE OVER THE ROOM.
//
// D18 (t257) made an over-budget assembly converge for a row whose bulk is text: it is shown as head + tail +
// a `msg:<id>` pointer. Its final re-review found the gap this file pins: a row whose bulk is NOT text was
// still shown whole. Two real shapes:
//   (a) the owner attaches a large PDF. The stored row is text (the attachment pointer the chat route writes);
//       the document block is injected after the assembly (`injectAttachmentBlocks`), so no trim and no fold
//       ever saw its cost, and the boundary refused the same array on every wake;
//   (b) an assistant row whose `tool_use` input is huge (a file written by a larger-window model), forced in
//       whole as the newest group.
// Driven MULTI-ROUND through the same real doors as `an-over-budget-assembly-converges.test.ts`: the
// assembler behind the assemble step's out-of-view fold door, the turn's own attachment step, the provider boundary, the real forced condense (scripted
// writer), `recoverFromError` and its park. Each round is the next turn the park's wake would run.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
const seen = vi.hoisted(() => ({ cards: [] as Array<{ type?: string; code?: string }>, texts: [] as string[], wakes: 0 }));
vi.mock('../../../gateway/ws.js', () => ({
  broadcast: (e: { type?: string; code?: string }) => { seen.cards.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../runtime.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentRuntime: () => ({ notifyPrimaryOfInjury: vi.fn(async () => undefined), handleMessage: vi.fn(async () => { seen.wakes++; }) }),
}));
vi.mock('../../../services/imessage-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendAlert: (words: string) => { seen.texts.push(words); },
}));
vi.mock('../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => undefined, storeEmbedding: async () => undefined, refreshEmbedding: () => undefined,
}));
vi.mock('../../../tools/tool-docs.js', async () => {
  const actual = await vi.importActual<typeof import('../../../tools/tool-docs.js')>('../../../tools/tool-docs.js');
  return { ...actual, measureAgentToolPayloadTokens: async () => 2_000, filterToolsForApiCall: () => [], getAgentAlwaysLoadedTools: () => [] };
});
vi.mock('../../../providers/anthropic-sdk.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callAnthropicViaSdk: async () => ({ content: 'The crates on the north dock were counted and the totals written on the board.', toolCalls: [], inputTokens: 40, outputTokens: 20, stopReason: 'end_turn' }),
}));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { assembleContext } from '../../../memory/assembler.js';
import { assembleWithNothingOutOfViewUnsummarised } from '../../../memory/out-of-view-fold.js';
import { validateAtProviderBoundary, AssemblyValidationError, type ValidatedMessage } from '../../../memory/assembly-validation.js';
import { collectMessageLaneIds } from '../../../memory/message-lane-tag.js';
import { __resetBrakesForTests } from '../../../memory/compaction-brakes.js';
import { recoverFromError } from '../recovery.js';
import { initState, advance } from '../state.js';
import { pendingWakeups } from '../../shared-state.js';
import { withLock } from '../../../db/with-lock.js';
import { injectDelegationHintAndAttachments } from '../steps/assemble/delegation-and-attachments.js';
import { buildOpenAIMessages } from '../../model.js';
import { contractForModel } from '../../model-contract.js';

vi.setConfig({ testTimeout: 120_000 });

const AGENT = 'agent-d18b-converge';
const MODEL = 'm-d18b-32k';
const WINDOW = 32_768;
const db = (): Database.Database => mockDb.current!;
const files = fs.mkdtempSync(path.join(os.tmpdir(), 'd18b-'));
afterAll(() => { fs.rmSync(files, { recursive: true, force: true }); });

beforeEach(async () => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  seen.cards.length = 0; seen.texts.length = 0; seen.wakes = 0;
  pendingWakeups.clear();
  __resetBrakesForTests();
  (await import('../../../memory/window-starvation-card.js')).__resetStarvedWindowsForTests();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
    VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, 'prov', 'Dock 32K', 'sonnet', '["text","tools","vision"]', ?, 4096, 1, datetime('now'), datetime('now'))`).run(MODEL, WINDOW);
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES (?, 'The Agent', ?, 'working', '{}', datetime('now'), datetime('now'))`).run(AGENT, MODEL);
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', 'nobody')").run();
  const reply = 'Counted another stack on the north dock; the running total is on the board beside the ramp. ';
  for (let t = 1; t <= 120; t++) {
    db().prepare(`INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
      VALUES (?, ?, 'user', datetime('now'), datetime('now'), 'answered', 1)`).run(AGENT, t);
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] Keep counting the crates.`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[reply ${t}] ${reply.repeat(6)}`, turnNumber: t });
  }
  (await import('../full-context-wait.js')).__resetFullContextWaitForTests();
  (await import('../../../memory/forced-pass-progress.js')).__resetForcedPassProgressForTests();
});
afterEach(async () => {
  await Promise.race([withLock(`compact:${AGENT}`, async () => undefined, { ifBusy: 'wait' }), new Promise((r) => setTimeout(r, 15_000))]);
  mockDb.current?.close();
  mockDb.current = null;
});

const STATE = () => advance(initState({
  agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: MODEL, turnNumber: 130,
  triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'check it',
  lastUserMessageId: null, inboundChannel: null, inboundContext: null, pendingTechniqueAck: null,
}), { loopCount: 1 });

/** One dial of one turn as the assemble step builds it: the assembly through its out-of-view fold door, then the
 *  turn's attachment step, then the boundary. */
async function dial(): Promise<{ refusal: AssemblyValidationError | null; messages: ValidatedMessage[]; systemPrompt: string }> {
  const assembled = await assembleWithNothingOutOfViewUnsummarised(AGENT, WINDOW, () => assembleContext(AGENT, MODEL));
  const messages = [...assembled.messages] as ValidatedMessage[];
  await injectDelegationHintAndAttachments(STATE(), {
    agentId: AGENT, turnNumber: 130, counterparty: { kind: 'user' } as never, lastUserMessageContent: null,
    mctx: {} as never, messages: messages as never, roomTokens: assembled.allocation?.budgetTokens,
  } as never);
  try {
    await validateAtProviderBoundary({ agentId: AGENT, modelId: MODEL, messages, systemPrompt: assembled.systemPrompt, contextWindow: WINDOW, maxOutputTokens: 4096, laneIds: collectMessageLaneIds(messages) });
    return { refusal: null, messages, systemPrompt: assembled.systemPrompt };
  } catch (e) {
    if (e instanceof AssemblyValidationError) return { refusal: e, messages, systemPrompt: assembled.systemPrompt };
    throw e;
  }
}

/** Rounds through the real park and wake (fake timers advance the brake's clock) until the dial fits. */
async function answersThroughThePark(maxRounds: number): Promise<{ fitted: boolean; rounds: number; refusals: string[]; last: Awaited<ReturnType<typeof dial>> | null }> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const refusals: string[] = [];
  let rounds = 0;
  try {
    for (let round = 1; round <= maxRounds; round++) {
      rounds = round;
      const d = await dial();
      if (!d.refusal) return { fitted: true, rounds, refusals, last: d };
      refusals.push(d.refusal.message);
      const state = advance(initState({
        agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: MODEL, turnNumber: 900 + round,
        triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'check it',
        lastUserMessageId: null, inboundChannel: null, inboundContext: null, pendingTechniqueAck: null,
      }), { loopCount: 1 });
      await recoverFromError(state, d.refusal, { isUserFacingTurn: true });
      if (pendingWakeups.has(AGENT)) { pendingWakeups.clear(); continue; }
      const woke = seen.wakes;
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      for (let i = 0; i < 50 && seen.wakes === woke; i++) await new Promise((r) => setImmediate(r));
    }
  } finally { vi.useRealTimers(); }
  return { fitted: false, rounds, refusals, last: null };
}

const noRepeatedRefusal = (refusals: string[]): void => {
  for (let i = 1; i < refusals.length; i++) expect(refusals[i], `wake ${i + 1} does not see wake ${i}'s refusal`).not.toBe(refusals[i - 1]);
};

async function readWhole(id: string, search: string): Promise<{ isError: boolean; content: string }> {
  const { resultReadHandlers } = await import('../../tools/cat/result-read.js');
  return resultReadHandlers.tool_result_read({ agentId: AGENT, name: 'tool_result_read', args: { id, search }, callId: 'c', toolCall: {} as never });
}

/** Every tool call is answered by the very next message, by id, in the Anthropic shape. */
function anthropicPairsValid(messages: ValidatedMessage[]): void {
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    const uses = (m.content as Array<{ type: string; id?: string }>).filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (uses.length === 0) return;
    const next = messages[i + 1];
    const answered = Array.isArray(next?.content) ? (next.content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : [];
    expect(next?.role, `the call at ${i} is answered by the next message`).toBe('user');
    expect(answered.sort(), `every call id at ${i} has its result`).toEqual([...uses].sort());
  });
}

/** The OpenAI-compatible shape: every tool_call is followed by its `tool` message, and its arguments parse. */
async function openAIPairsValid(messages: ValidatedMessage[], systemPrompt: string): Promise<Array<Record<string, unknown>>> {
  const contract = contractForModel({ providerBaseUrl: 'https://openrouter.ai/api', apiModelId: 'minimax/minimax-m2.7' });
  const wire = await buildOpenAIMessages(systemPrompt, messages as never, AGENT, contract, '') as unknown as Array<Record<string, unknown>>;
  wire.forEach((m, i) => {
    const calls = (m.tool_calls as Array<{ id: string; function: { arguments: string } }> | undefined) ?? [];
    if (calls.length === 0) return;
    const followers: string[] = [];
    for (let j = i + 1; j < wire.length && wire[j].role === 'tool'; j++) followers.push(wire[j].tool_call_id as string);
    expect(followers.sort(), `every tool_call at ${i} is followed by its tool message`).toEqual(calls.map((c) => c.id).sort());
    for (const c of calls) expect(() => JSON.parse(c.function.arguments), 'the arguments are JSON').not.toThrow();
  });
  return wire;
}

// ── (a) The owner attaches a large PDF ───────────────────────────────────────────────────────────────
describe('D18b: an owner message whose attachment alone is over the room', () => {
  it('a ~400 KB PDF on a 32K window: the agent answers within a few rounds, no repeated refusal; the view keeps the attachment pointer and says the document is not shown', async () => {
    const pdfPath = path.join(files, 'manifest-scan.pdf');
    fs.writeFileSync(pdfPath, `%PDF-1.4\n${'0 0 obj << /Crate 0412 /Dock (north) >> endobj\n'.repeat(9_000)}%%EOF\n`);
    const size = fs.statSync(pdfPath).size;
    const content = `[ask 121] Please check the scanned manifest.\n\n[PDF attached: manifest-scan.pdf (${size} bytes), fileId: file-scan]\nPath: ${pdfPath}\nIf your model supports PDF input, the contents are shown to you in this message. To read the text yourself — or if no contents appear inline — call pdf_read with this Path.`;
    insertMessage({ id: 'msg-owner-pdf', agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content, turnNumber: 121,
      attachments: JSON.stringify([{ fileId: 'file-scan', filename: 'manifest-scan.pdf', mimeType: 'application/pdf', size, path: pdfPath, category: 'pdf' }]) });
    const { fitted, rounds, refusals, last } = await answersThroughThePark(6);
    expect(fitted, `the agent answers (after ${rounds} rounds)`).toBe(true);
    expect(rounds, 'within a few rounds').toBeLessThanOrEqual(3);
    noRepeatedRefusal(refusals);
    const shown = JSON.stringify(last!.messages);
    expect(shown, 'never the document bytes').not.toContain(Buffer.from('%PDF-1.4').toString('base64').slice(0, 8));
    expect(shown.length, 'never the whole document').toBeLessThan(200_000);
    expect(shown, 'the platform\'s attachment pointer is still there: name, size, Path, reader').toContain('[PDF attached: manifest-scan.pdf');
    expect(shown, 'and the view says it is not shown inline').toMatch(/manifest-scan\.pdf[^\]]*NOT shown/);
    expect(seen.texts, 'no stall, so no text').toEqual([]);
  });

  it('control: a small PDF that fits the room is still shown to the model as its document block', async () => {
    const pdfPath = path.join(files, 'one-page.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4\n0 0 obj << /Crate 0412 >> endobj\n%%EOF\n');
    const size = fs.statSync(pdfPath).size;
    insertMessage({ id: 'msg-owner-small-pdf', agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', turnNumber: 121,
      content: `[ask 121] One page.\n\n[PDF attached: one-page.pdf (${size} bytes), fileId: file-one]\nPath: ${pdfPath}`,
      attachments: JSON.stringify([{ fileId: 'file-one', filename: 'one-page.pdf', mimeType: 'application/pdf', size, path: pdfPath, category: 'pdf' }]) });
    const { refusal, messages } = await dial();
    expect(refusal).toBeNull();
    expect(messages.some((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === 'document')), 'the document block rides').toBe(true);
  });
});

// ── (b) An assistant row with a huge tool_use input ──────────────────────────────────────────────────
describe('D18b: an assistant row whose tool_use input alone is over the room', () => {
  const ROW = 'msg-the-big-write';
  function storeTheBigWrite(): void {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: '[ask 121] Write the whole manifest to a file.', turnNumber: 121 });
    const body = `${'crate 0412, north dock, sealed, 40 kg, inspected\n'.repeat(4_000)}END OF FILE`;
    insertMessage({ id: ROW, agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: 121, content: JSON.stringify([
      { type: 'text', text: 'Writing the manifest file now.' },
      { type: 'tool_use', id: 'call-write-manifest', name: 'file_write', input: { path: '/tmp/manifest.txt', content: body } },
    ]) });
    insertMessage({ agentId: AGENT, role: 'tool', lane: 'owner', turnNumber: 121, content: JSON.stringify([
      { type: 'tool_result', tool_use_id: 'call-write-manifest', content: 'Wrote 200,011 characters to /tmp/manifest.txt.' },
    ]) });
  }

  it('it fits within a few rounds, the agent answers, no repeated refusal; the call keeps its id and name, its input is head + tail + pointer, and the whole is one read away', async () => {
    storeTheBigWrite();
    const { fitted, rounds, refusals, last } = await answersThroughThePark(6);
    expect(fitted, `the agent answers (after ${rounds} rounds)`).toBe(true);
    expect(rounds, 'within a few rounds').toBeLessThanOrEqual(3);
    noRepeatedRefusal(refusals);
    const call = last!.messages.flatMap((m) => (Array.isArray(m.content) ? m.content as Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> : []))
      .find((b) => b.type === 'tool_use' && b.id === 'call-write-manifest');
    expect(call, 'the call is in view').toBeDefined();
    expect(call!.name).toBe('file_write');
    expect(call!.input!.path, 'a short argument is shown as it is').toBe('/tmp/manifest.txt');
    const shownBody = String(call!.input!.content);
    expect(shownBody, 'the head').toContain('crate 0412, north dock');
    expect(shownBody, 'the tail').toContain('END OF FILE');
    expect(shownBody, 'the pointer names the block').toContain(`msg:${ROW}#1`);
    expect(shownBody.length, 'never the whole').toBeLessThan(20_000);
    const handle = /msg:[^"\s]+#1[^"\s,)]*/.exec(shownBody)![0];
    const read = await readWhole(handle, 'END OF FILE');
    expect(read.isError, read.content.slice(0, 200)).toBe(false);
    expect(read.content).toContain('END OF FILE');
    anthropicPairsValid(last!.messages);
    await openAIPairsValid(last!.messages, last!.systemPrompt);
    expect(seen.texts, 'no stall, so no text').toEqual([]);
  });
});
