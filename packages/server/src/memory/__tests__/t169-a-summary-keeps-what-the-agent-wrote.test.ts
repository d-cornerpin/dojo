// ════════════════════════════════════════════════════════════════════════════════════════
// t169 — A SUMMARY KEEPS WHAT THE AGENT AUTHORED (run 9, S1 attempt 2).
//
// `condenseToolJsonForSummary` rendered every `tool_use` as `(called tool NAME)` and dropped its input,
// so the words the agent WROTE — a note, a file's content, a message payload — never reached the
// summariser. The wrong-line lists lived only in `work_note` arguments: the summary said "called
// work_note three times" and nothing else, and the agent re-walked 154 pages to rebuild them.
//
// Clauses:
//   1  a summary input built from a `work_note` row carries the note's text (through the real
//      compaction door as well as the input builder);
//   2  text the agent authored under any of the authored fields is kept next to the tool name;
//   3  paths, ids and queries are NOT authored text: a `file_read` call renders byte-for-byte as it did;
//   4  results stay as they were (the first 200 chars);
//   5  the size is the summariser's own input budget, not a number picked here: it keeps everything
//      while the chunk fits, and scales every kept text down together (never to nothing, never past the
//      budget) when it does not;
//   6  a technique body or a credential value the agent passes as input is never carried (the same
//      rule the result scrub already enforces).
//
// RED-FIRST at 104a7dd6: committed as `it.fails`, flipped with the fix. Clauses 3, 4 and the controls
// of 5 and 6 pass before the fix and stay as the guard.
// ════════════════════════════════════════════════════════════════════════════════════════

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

// The summariser's model call is a recorder: what it was handed is the subject.
const modelStub = { reply: 'a real summary of the span', seen: [] as string[] };
vi.mock('../../agent/model.js', () => ({
  callModel: async (...args: unknown[]) => {
    modelStub.seen.push(JSON.stringify(args));
    return { content: modelStub.reply, toolCalls: [], usage: {} };
  },
  getModelOutputCap: () => 4096,
}));

import { insertMessage } from '../message-store.js';
import { runMigrations } from '../../db/migrations.js';
import { runLeafCompaction, buildLeafSummaryInput, condenseToolJsonForSummary } from '../compaction.js';
import { estimateTokens } from '../budget.js';
import type { Message } from '@dojo/shared';

const AGENT = 'agent-t169';
const MODEL = 'model-t169';
const SMALL_WINDOW = 8000;
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  modelStub.reply = 'a real summary of the span';
  modelStub.seen = [];
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')").run(AGENT, 'T169');
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const use = (name: string, input: Record<string, unknown>, id = 'toolu_1'): string =>
  JSON.stringify([{ type: 'tool_use', id, name, input }]);
const result = (body: string, id = 'toolu_1', is_error = false): string =>
  JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: body, ...(is_error ? { is_error } : {}) }]);

function asMessage(id: string, role: Message['role'], content: string): Message {
  return {
    id, agentId: AGENT, role, content,
    tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: '2026-10-15 07:44:37',
  } as Message;
}
/** One persisted assistant row (the engine stores a turn's tool_use blocks as a JSON array). */
function row(content: string, role: Message['role'] = 'assistant'): Message {
  const stored = insertMessage({ agentId: AGENT, role, lane: 'owner', content });
  return asMessage(stored.id, role, content);
}

const NOTE = 'Pages 1-8, wrong lines: p2 line 4 (qty 3 x 4.00 = 13.00), p5 line 9 (total 70.00 should be 7.00)';

describe('1 — what the agent wrote with work_note reaches the summariser', () => {
  it('the input built from a work_note row carries the note text, next to the tool name', () => {
    const input = buildLeafSummaryInput([row(use('work_note', { task_id: 'task-1', notes: NOTE }))]);
    expect(input).toContain('work_note');
    expect(input).toContain(NOTE);
  });

  it('through the real compaction door: the model that writes the summary is handed the note text', async () => {
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: use('work_note', { task_id: 'task-1', notes: NOTE }) });
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: result('[OK] task_id=task-1 Observation appended to the task\'s audit trail.') });
    for (let i = 0; i < 24; i++) insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `tail filler ${i}` });
    const created = await runLeafCompaction(AGENT, MODEL, SMALL_WINDOW);
    expect(created).toBeGreaterThan(0);
    expect(modelStub.seen.join('\n')).toContain('p5 line 9 (total 70.00 should be 7.00)');
  });
});

describe('2 — the text the agent authored is kept, whichever tool it was written with', () => {
  const authored: Array<[string, Record<string, unknown>, string]> = [
    ['a file write', { path: '/work/out/plan.md', content: 'PLAN-BODY step one then step two' }, 'PLAN-BODY step one then step two'],
    ['a message to another agent', { agent: 'agent-x', intent: 'handoff', payload: 'PAYLOAD-BODY please re-check page 9' }, 'PAYLOAD-BODY please re-check page 9'],
    ['a text message', { recipient: '+15550100', message: 'MESSAGE-BODY running late' }, 'MESSAGE-BODY running late'],
    ['a status change with a reason', { task_id: 't', status: 'blocked', notes: 'NOTES-BODY waiting on the supplier answer' }, 'NOTES-BODY waiting on the supplier answer'],
    ['an opened task with a description', { title: 'audit', description: 'DESCRIPTION-BODY check every line total' }, 'DESCRIPTION-BODY check every line total'],
  ];
  for (const [what, input, text] of authored) {
    it(`${what}: the text comes through`, () => {
      expect(buildLeafSummaryInput([row(use('some_tool', input))])).toContain(text);
    });
  }

  it('a multi-line text is kept whole, in order', () => {
    const body = 'first line\nsecond line\nthird line';
    const out = condenseToolJsonForSummary(use('work_note', { task_id: 't', notes: body }));
    expect(out).toContain(body);
  });

  it('an assistant turn with prose and a call keeps both, in order', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'Recording the first block now.' },
      { type: 'tool_use', id: 'toolu_1', name: 'work_note', input: { task_id: 't', notes: NOTE } },
    ]);
    const out = condenseToolJsonForSummary(content);
    expect(out.indexOf('Recording the first block now.')).toBeLessThan(out.indexOf(NOTE));
  });
});

describe('3 — paths, ids and queries are not authored text: they render as they did', () => {
  it('a file_read call is byte-for-byte what it was', () => {
    expect(condenseToolJsonForSummary(use('file_read', { path: '/work/ledger/page-017.txt' })))
      .toBe('(called tool file_read)');
    expect(condenseToolJsonForSummary(use('file_read', { path: '/work/ledger/page-017.txt', offset: 40, limit: 200 })))
      .toBe('(called tool file_read)');
  });

  it('a search and an id lookup are unchanged too', () => {
    expect(condenseToolJsonForSummary(use('history_search', { query: 'ledger closing code' }))).toBe('(called tool history_search)');
    expect(condenseToolJsonForSummary(use('work_update', { action: 'get', id: 'task-1' }))).toBe('(called tool work_update)');
  });

  it('a call with no input and a call with a non-text input are unchanged', () => {
    expect(condenseToolJsonForSummary(use('get_current_time', {}))).toBe('(called tool get_current_time)');
    expect(condenseToolJsonForSummary(JSON.stringify([{ type: 'tool_use', id: 'x', name: 'exec' }]))).toBe('(called tool exec)');
  });
});

describe('4 — results stay as they were', () => {
  it('a result keeps its first 200 characters and its error flag', () => {
    expect(condenseToolJsonForSummary(result('r'.repeat(500)))).toBe(`(tool result: ${'r'.repeat(200)})`);
    expect(condenseToolJsonForSummary(result('boom', 'toolu_1', true))).toBe('(tool result ERROR: boom)');
  });

  it('plain text passes through untouched', () => {
    expect(condenseToolJsonForSummary('just words, not JSON')).toBe('just words, not JSON');
  });
});

describe("5 — the size is the summariser's own input budget", () => {
  const big = (tag: string, chars: number): string => `${tag} ` + 'w'.repeat(chars);

  it('everything the agent wrote is kept while the chunk fits its budget', () => {
    const rows = [row(use('work_note', { task_id: 't', notes: big('ONE', 6000) }, 'a')), row(use('work_note', { task_id: 't', notes: big('TWO', 6000) }, 'b'))];
    const input = buildLeafSummaryInput(rows, 30_000);
    expect(input).toContain(big('ONE', 6000));
    expect(input).toContain(big('TWO', 6000));
  });

  it('over the budget, the input stays within it and every text keeps its head, with an honest cut', () => {
    const rows = [
      row(use('work_note', { task_id: 't', notes: big('ONE', 40_000) }, 'a')),
      row(use('file_write', { path: '/x', content: big('TWO', 40_000) }, 'b')),
    ];
    const budget = 6000;
    const input = buildLeafSummaryInput(rows, budget);
    expect(estimateTokens(input)).toBeLessThanOrEqual(budget);
    expect(input).toContain('ONE ww');
    expect(input).toContain('TWO ww');
    expect(input).toMatch(/not shown/i);
  });

  it('a single row bigger than the whole budget still yields an input within it', () => {
    const input = buildLeafSummaryInput([row(use('file_write', { path: '/x', content: big('HUGE', 400_000) }))], 8000);
    expect(estimateTokens(input)).toBeLessThanOrEqual(8000);
    expect(input).toContain('HUGE ww');
  });
});

describe('6 — secrets and technique bodies the agent passes as input are never carried', () => {
  it('credential_* and technique_* inputs render as the bare call', () => {
    expect(condenseToolJsonForSummary(use('credential_add', { name: 'supplier', value: 'SECRET-VALUE', notes: 'SECRET-NOTE' })))
      .toBe('(called tool credential_add)');
    expect(condenseToolJsonForSummary(use('technique_finalize', { name: 'x', content: 'TECHNIQUE-BODY steps...' })))
      .toBe('(called tool technique_finalize)');
  });
});
