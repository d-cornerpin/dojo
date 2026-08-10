// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 6 T24 — COMPACTION NEVER ERASES ANSWERED-STATE.
//
// THE INCIDENT, re-measured at HEAD by this worker's own queries (the plan named a
// different branch; the ledger and the log name this one):
//
//   sum_ab11450f-d649-4092-984c-294dfb63b926 — agent 57b52025, 2026-08-10 22:56:03,
//   content '' (zero bytes), token_count 0, 51 source rows marked compacted. Those 51
//   rows are the round-5 afternoon: "Can you text my phone?" AND its answer, the hike
//   research AND its answer, the uploads cleanup AND its approval.
//
//   dojo.log, same second:
//     22:56:03.405 warn  v2-loop        "background drain wall-clock timeout, aborting"  (60000ms)
//     22:56:03.423 info  model          "OpenAI call completed"  outputTokens=1 latencyMs=59968
//     22:56:03.423 info  memory-summarize "Summary generated (level 1: normal)" resultTokens=0
//     22:56:03.426 info  memory-dag     "Created leaf summary"  messageCount=51 tokenCount=0
//
// The chunk's FILTERED content was NOT empty (7 owner-lane user rows, 24 assistant rows;
// only one `[SOURCE: SCHEDULER…]` row is filtered) — so the empty-filter placeholder branch
// never ran. What ran was `generateSummary`'s success path over an ABORTED model call that
// returned nothing: `estimateTokens('') = 0 <= 5000 * 1.5`, so an empty string was returned
// as `{ok:true}` and `createLeafSummary` marked all 51 rows compacted behind it.
//
// THE LAW THE TREE ALREADY STATES, in two places, and did not enforce here:
//   • `summarize.ts:164-178` — "A refusal is not a placeholder… marking the sources
//     compacted destroys the rows."  An EMPTY summary is the same lie with a shorter body.
//   • `summary-rebuild.ts:330-335` — the nightly rebuild ALREADY refuses empty output
//     ("Summary rebuild produced empty output; leaving summary for a later night"). The live
//     write path, which is the one that reclaims rows, did not.
//
// And the branch the plan named is a real, LATENT hole, measured on the same body: the three
// genuine placeholder summaries hold 0 owner-lane user rows and 0 answer-stamped rows, while
// the eaten spans hold 7 and 3. So the ledger guard below refuses the branch for real Q&A and
// leaves every genuine plumbing span byte-identical.
// ════════════════════════════════════════════════════════════════════════════════

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

// The summarizer's model call is the subject of half this file, so it is a controllable stub
// rather than a network call. `callModel` is what `generateSummary` calls.
const modelStub = { reply: 'a real summary of the span', throwErr: null as Error | null };
vi.mock('../../agent/model.js', () => ({
  callModel: async () => {
    if (modelStub.throwErr) throw modelStub.throwErr;
    return { content: modelStub.reply, toolCalls: [], usage: {} };
  },
  getModelOutputCap: () => 4096,
}));

import { insertMessage } from '../message-store.js';
import { runMigrations } from '../../db/migrations.js';
import { generateSummary } from '../summarize.js';
import { runLeafCompaction, buildLeafSummaryInput, NO_CONVERSATION_PLACEHOLDER } from '../compaction.js';
import { getCompactedMessageIds } from '../dag.js';
import type { Message } from '@dojo/shared';

const AGENT = 'agent-t24';
const MODEL = 'model-t24';
/** Small window ⇒ fresh tail of 24 rows (budget.ts:352). Everything before that compacts. */
const SMALL_WINDOW = 8000;

const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  modelStub.reply = 'a real summary of the span';
  modelStub.throwErr = null;
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')").run(AGENT, 'T24');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** 24 filler rows so everything seeded BEFORE them sits outside the fresh tail. */
function padFreshTail(): void {
  for (let i = 0; i < 24; i++) {
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `tail filler ${i}` });
  }
}

function stampAnswer(askId: string, answerId: string): void {
  db().prepare('UPDATE messages SET answer_message_id = ?, served_by_turn = 4634 WHERE id = ?')
    .run(answerId, askId);
}

function summaries(): Array<{ id: string; content: string; token_count: number }> {
  return db().prepare('SELECT id, content, token_count FROM summaries').all() as never;
}

// ════════════════════════════════════════════════════════════════════
// 1. THE INCIDENT — an empty model result is a REFUSAL, not a summary.
// ════════════════════════════════════════════════════════════════════

describe('an empty summariser result never reclaims the rows it did not read', () => {
  it('RED: generateSummary refuses empty model output instead of returning it as ok', async () => {
    modelStub.reply = '';
    const result = await generateSummary({
      content: '[USER · the owner] Can you text my phone?\n\n---\n\n[ASSISTANT] Yes — I can text your phone via SMS right now.',
      depth: 0, targetTokens: 5000, agentId: AGENT, modelId: MODEL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/i);
  });

  it('RED: whitespace-only output is the same refusal (an aborted stream emits one token)', async () => {
    modelStub.reply = '\n \n';
    const result = await generateSummary({
      content: 'a real span of conversation',
      depth: 0, targetTokens: 5000, agentId: AGENT, modelId: MODEL,
    });
    expect(result.ok).toBe(false);
  });

  it('RED: an ABORTED call is refused even if the provider returned bytes', async () => {
    const ac = new AbortController();
    ac.abort();
    modelStub.reply = 'half a summ';
    const result = await generateSummary({
      content: 'a real span of conversation',
      depth: 0, targetTokens: 5000, agentId: AGENT, modelId: MODEL, abortSignal: ac.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/abort/i);
  });

  it('control: a real summary is still returned ok, unchanged', async () => {
    modelStub.reply = 'The owner asked about SMS; the agent confirmed SMS is live.';
    const result = await generateSummary({
      content: 'a real span', depth: 0, targetTokens: 5000, agentId: AGENT, modelId: MODEL,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('The owner asked about SMS; the agent confirmed SMS is live.');
  });

  it('RED (through the door): the 51-row shape survives an aborted summariser', async () => {
    const ask = insertMessage({
      agentId: AGENT, role: 'user', lane: 'owner', content: 'Can you text my phone? If not, what ways CAN you reach me right now?',
    });
    const answer = insertMessage({
      agentId: AGENT, role: 'assistant', lane: 'owner', content: 'Yes — I can text your phone via SMS right now (that channel is live).',
    });
    stampAnswer(ask.id, answer.id);
    padFreshTail();

    modelStub.reply = '';  // the aborted call's body
    const created = await runLeafCompaction(AGENT, MODEL, SMALL_WINDOW);

    expect(created).toBe(0);
    expect(summaries()).toHaveLength(0);
    const compacted = getCompactedMessageIds(AGENT);
    expect(compacted.has(ask.id)).toBe(false);
    expect(compacted.has(answer.id)).toBe(false);
  });

  it('control: a healthy summariser still compacts the same span exactly as before', async () => {
    const ask = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'Can you text my phone?' });
    const answer = insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: 'Yes — SMS is live.' });
    stampAnswer(ask.id, answer.id);
    padFreshTail();

    const created = await runLeafCompaction(AGENT, MODEL, SMALL_WINDOW);
    expect(created).toBe(1);
    expect(summaries()[0].content).toBe('a real summary of the span');
    expect(getCompactedMessageIds(AGENT).has(ask.id)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. THE PLACEHOLDER BRANCH — the ledger decides, never the content filter.
// ════════════════════════════════════════════════════════════════════

describe('the placeholder path is only taken over spans the ledger calls plumbing', () => {
  it('RED: a filtered-empty chunk holding a real answered ask is LEFT UNCOMPACTED', async () => {
    // Both rows are swallowed by the content filter — the ask via the SOUL-prompt anchor,
    // the answer via the "having trouble" anchor — yet the ledger records a real answered
    // exchange. Today: placeholder written, both rows reclaimed.
    const ask = insertMessage({
      agentId: AGENT, role: 'user', lane: 'owner', content: '# Identity\nwho am I to you?',
    });
    const answer = insertMessage({
      agentId: AGENT, role: 'assistant', lane: 'owner',
      content: "I'm sorry — I'm having trouble reaching that service, but here is the answer you asked for.",
    });
    stampAnswer(ask.id, answer.id);
    padFreshTail();

    const created = await runLeafCompaction(AGENT, MODEL, SMALL_WINDOW);

    expect(created).toBe(0);
    expect(summaries()).toHaveLength(0);
    expect(getCompactedMessageIds(AGENT).has(ask.id)).toBe(false);
  });

  it('control: a genuinely-plumbing-only chunk still takes the placeholder path', async () => {
    // The measured shape of all three real placeholder summaries on the dev body: zero
    // owner-lane user rows, zero answer stamps — scheduler triggers and inbound A2A only.
    const poke = insertMessage({
      agentId: AGENT, role: 'user', lane: 'events',
      content: '[SOURCE: SCHEDULER — automated scheduled task trigger, not a message from the user] run #1',
    });
    const a2a = insertMessage({
      agentId: AGENT, role: 'user', lane: 'a2a', sourceAgentId: 'kevin',
      content: '[A2A: from kevin] the deck is done',
    });
    padFreshTail();

    const created = await runLeafCompaction(AGENT, MODEL, SMALL_WINDOW);

    expect(created).toBe(1);
    expect(summaries()[0].content).toBe(NO_CONVERSATION_PLACEHOLDER);
    const compacted = getCompactedMessageIds(AGENT);
    expect(compacted.has(poke.id)).toBe(true);
    expect(compacted.has(a2a.id)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. THE SUMMARISER CONTRACT — the ask's answered-state rides its own row.
// ════════════════════════════════════════════════════════════════════

describe('a user ask reaches the summariser carrying its answered state', () => {
  function asMessage(row: { id: string }, role: Message['role'], content: string): Message {
    return {
      id: row.id, agentId: AGENT, role, content,
      tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: '2026-08-10 20:52:31',
    } as Message;
  }

  it('RED: an answered ask is tagged with the turn that answered it', () => {
    const ask = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'Can you text my phone?' });
    const answer = insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: 'Yes — SMS is live.' });
    stampAnswer(ask.id, answer.id);

    const input = buildLeafSummaryInput([
      asMessage(ask, 'user', 'Can you text my phone?'),
      asMessage(answer, 'assistant', 'Yes — SMS is live.'),
    ]);

    expect(input).toMatch(/ANSWERED in turn 4634/);
    // The rebuild's role-tag stripper is `^\s*\[(USER|…)\b[^\]]*\]` — a `]` inside the tag
    // would break the replay it exists to perform.
    expect(input.split('\n')[0].slice(0, input.split('\n')[0].indexOf(']'))).not.toContain('ANSWERED]');
  });

  it('control: an unanswered ask carries no answered stamp', () => {
    const ask = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'still thinking about it?' });
    const input = buildLeafSummaryInput([asMessage(ask, 'user', 'still thinking about it?')]);
    expect(input).not.toMatch(/ANSWERED/);
  });

  it('control: assistant rows are never tagged', () => {
    const ask = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'q' });
    const answer = insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: 'a' });
    stampAnswer(ask.id, answer.id);
    const input = buildLeafSummaryInput([asMessage(answer, 'assistant', 'a')]);
    expect(input).not.toMatch(/ANSWERED/);
  });
});
