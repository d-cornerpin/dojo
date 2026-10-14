// ════════════════════════════════════════════════════════════════════════════════════════
// t144 — THE NIGHTLY JOB REBUILDS RECENT MIXED NOTES, ONE CONVERSATION EACH, AND FAILS WELL.
//
// OR-V333-SET (8) + OR-REBUILD-SCOPE: notes from before the update that mixed conversations, whose
// source rows all fall in the 14 days before it, are re-condensed per conversation from the original
// messages by the EXISTING nightly job; the older note stays in view, labelled "older mixed notes",
// until its replacement lands, so there is never a gap. Owner ruling 2026-10-13 (no hard limits): no
// count — paced by a writer answering, the agent not mid-turn, and the money guardrail.
//
// Lifecycle shapes (feature-testing standing order): an interrupted rebuild resumes without paying
// twice; a refused dial leaves the older note, labelled; a version that knew nothing of labels wrote
// notes in between (downgrade, then upgrade); a conversation deleted while its rebuild was queued.
//
// THE DOORS: a migrated DB; the real nightly job (`runSummaryRebuildBatch`), the real assembler; the
// model is scripted.
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
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));

const model = vi.hoisted(() => ({
  calls: [] as string[],
  /** Answer empty on this call number (1-based) — a refusal. */
  refuseCall: 0,
}));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { messages: Array<{ content: string }> }) => {
    const content = String(p.messages[0]?.content ?? '');
    model.calls.push(content);
    if (model.calls.length === model.refuseCall) return { content: '', toolCalls: [], usage: {} };
    const conv = /^CONVERSATION: (.*)$/m.exec(content)?.[1] ?? 'unlabelled';
    return { content: `Rebuilt note for ${conv}: the seals were logged.`, toolCalls: [], usage: {} };
  },
  getContextWindow: () => 200_000,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

const fault = vi.hoisted(() => ({ leafFor: null as string | null, contextItemsOnce: false }));
vi.mock('../dag.js', async (orig) => {
  const real = await orig<typeof import('../dag.js')>();
  return {
    ...real,
    createLeafSummary: (...a: Parameters<typeof real.createLeafSummary>) => {
      if (fault.leafFor && a[0] === fault.leafFor) throw new Error('simulated defect row');
      return real.createLeafSummary(...a);
    },
  };
});
vi.mock('../compaction.js', async (orig) => {
  const real = await orig<typeof import('../compaction.js')>();
  return {
    ...real,
    rebuildContextItems: (agentId: string) => {
      if (fault.contextItemsOnce) { fault.contextItemsOnce = false; throw new Error('simulated crash before the view was rebuilt'); }
      return real.rebuildContextItems(agentId);
    },
  };
});

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { createLeafSummary, createCondensedSummary } from '../dag.js';
import { rebuildContextItems } from '../compaction.js';
import { assembleContext } from '../assembler.js';
import { runSummaryRebuildBatch } from '../summary-rebuild.js';
import { __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';
import { activeRuns } from '../../agent/shared-state.js';
import { setGlobalBudget } from '../../costs/budget.js';

const AGENT = 'agent-t144-rebuild';
const WRITER = 'model-t144-rebuild-writer';
const DASH = 'conv-t144-r-dash';
const MAIL = 'conv-t144-r-mail';
const DAY = 86_400_000;
const db = (): Database.Database => mockDb.current!;

function seed(): void {
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-t144r', 'Local', 'openai-compatible', 'api_key', 'http://localhost:11434/v1')").run();
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
                VALUES (?, 'p-t144r', 'writer', 'Writer', 200000, 4096, '["text","tools"]', 1, 0.5, 1.5)`).run(WRITER);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, WRITER);
  const conv = db().prepare('INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name) VALUES (?, ?, ?, ?, ?, ?)');
  conv.run(DASH, AGENT, 'dashboard', null, 'owner', null);
  conv.run(MAIL, AGENT, 'email', 'gmail', 'dispatch@depot.example', 'Depot Dispatch');
}

let n = 0;
/** `pairs` exchanges alternating between the two conversations, `daysAgo` before now. */
function history(pairs: number, daysAgo: number, agent = AGENT, convs: [string, string] = [DASH, MAIL]): string[] {
  const ids: string[] = [];
  for (let i = 0; i < pairs * 2; i++) {
    const conv = i % 2 === 0 ? convs[0] : convs[1];
    n++;
    const at = Date.now() - daysAgo * DAY + n * 60_000;
    const a = insertMessage({ agentId: agent, role: 'user', lane: 'owner', conversationId: conv, content: `[m${n}] Check crate ${n}.` });
    const b = insertMessage({ agentId: agent, role: 'assistant', lane: 'owner', conversationId: conv, content: `[m${n}r] Crate ${n} logged.` });
    db().prepare('UPDATE messages SET created_at = ? WHERE seq = ?').run(at, a.seq);
    db().prepare("UPDATE messages SET created_at = ?, subject_kind = 'conv' WHERE seq = ?").run(at + 1000, b.seq);
    ids.push(a.id, b.id);
  }
  return ids;
}

/** A note as a version before this release wrote it: agent-wide, both conversations, unlabelled. */
function olderNote(ids: string[], text = 'Mixed: the owner asked about crates; dispatch emailed about bays.', agent = AGENT): string {
  const s = createLeafSummary(agent, text, 400, ids, new Date().toISOString(), new Date().toISOString());
  db().prepare('UPDATE summaries SET subject_key = NULL, rebuild_state = NULL WHERE id = ?').run(s.id);
  return s.id;
}

const live = (): Array<{ id: string; subject_key: string | null; rebuild_state: string | null }> =>
  db().prepare(`SELECT s.id, s.subject_key, s.rebuild_state FROM summaries s JOIN context_items ci ON ci.item_id = s.id
                 WHERE ci.agent_id = ? AND ci.item_type = 'summary' ORDER BY s.earliest_at, s.id`).all(AGENT) as Array<{ id: string; subject_key: string | null; rebuild_state: string | null }>;
const coverCount = (id: string): number =>
  (db().prepare(`SELECT COUNT(*) AS k FROM summary_messages sm JOIN context_items ci ON ci.item_id = sm.summary_id WHERE sm.message_id = ?`).get(id) as { k: number }).k;
const viewOf = async (): Promise<string> => JSON.stringify((await assembleContext(AGENT, WRITER)).messages);

beforeEach(() => {
  n = 0;
  model.calls = [];
  model.refuseCall = 0;
  fault.leafFor = null; fault.contextItemsOnce = false;
  activeRuns.clear();
  __resetSummaryWriterHealthForTests();
  __resetBreakersForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  seed();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t144 — the 14-day scope, both ways', () => {
  it('a mixed note from 3 days before is rebuilt; one from 20 days before is labelled and never sent to a writer', async () => {
    const old = history(3, 20);      // rows m1..m6
    const recent = history(3, 3);
    olderNote(old, 'Old mixed note.');
    olderNote(recent);
    rebuildContextItems(AGENT);
    await runSummaryRebuildBatch();
    const rows = live();
    expect(rows.filter((r) => r.rebuild_state === 'legacy_mixed')).toHaveLength(1);
    expect(rows.filter((r) => r.subject_key?.startsWith('conv:'))).toHaveLength(2);
    expect(model.calls.some((c) => c.includes('[m1]')), 'the old note\'s messages never went to a writer').toBe(false);
    for (const id of recent) expect(coverCount(id), id).toBe(1);
    for (const id of old) expect(coverCount(id), id).toBe(1);
    const view = await viewOf();
    expect(view).toMatch(/conversation=\\"older mixed notes, [A-Z][a-z]{2} \d+, \d{4} to [A-Z][a-z]{2} \d+, \d{4}\\"/);
    expect(view).toMatch(/conversation=\\"dashboard conversation with [^"\\]+\\"/);
    expect(view).toMatch(/conversation=\\"email thread with Depot Dispatch/);
  });

  it('the boundary itself: 13 days in scope, 15 days out (the migration\'s own rule)', async () => {
    olderNote(history(1, 13));
    olderNote(history(1, 15));
    rebuildContextItems(AGENT);
    await runSummaryRebuildBatch();
    const states = (db().prepare('SELECT rebuild_state AS s FROM summaries WHERE agent_id = ? AND rebuild_state IS NOT NULL').all(AGENT) as Array<{ s: string }>).map((r) => r.s);
    expect(states).toEqual(['legacy_mixed']);
    expect(live().filter((r) => r.subject_key?.startsWith('conv:'))).toHaveLength(2);
  });
});

describe('t144 — no count: every queued note in one run, paced only by real signals', () => {
  it('forty queued notes are all rebuilt in one run (the old 30-per-night batch is gone)', async () => {
    for (let i = 0; i < 40; i++) olderNote(history(1, 2));
    rebuildContextItems(AGENT);
    const stats = await runSummaryRebuildBatch();
    expect(stats.legacy?.notesReplaced).toBe(40);
    expect(live().every((r) => r.rebuild_state === null && r.subject_key?.startsWith('conv:'))).toBe(true);
  });

  it('an agent mid-turn waits: nothing is dialled for it, its older note stays; idle again, it is rebuilt', async () => {
    olderNote(history(2, 2));
    rebuildContextItems(AGENT);
    activeRuns.add(AGENT);
    const busy = await runSummaryRebuildBatch();
    expect(model.calls).toHaveLength(0);
    expect(busy.legacy?.waiting[AGENT]).toMatch(/mid-turn/);
    expect(live().map((r) => r.rebuild_state)).toEqual(['legacy_mixed_rebuild']);
    activeRuns.delete(AGENT);
    await runSummaryRebuildBatch();
    expect(live()).toHaveLength(2);
  });

  it('the money guardrail: over today\'s limit, nothing is dialled and the note waits, labelled', async () => {
    olderNote(history(2, 2));
    rebuildContextItems(AGENT);
    setGlobalBudget(0);
    const stats = await runSummaryRebuildBatch();
    expect(model.calls).toHaveLength(0);
    expect(stats.legacy?.waiting[AGENT]).toMatch(/spending limit/);
    expect(await viewOf()).toMatch(/older mixed notes/);
  });
});

describe('t144 — the rebuild fails well (lifecycle shapes)', () => {
  it('a refused dial leaves the older note in view, labelled; the next run resumes WITHOUT re-paying the chunk that landed', async () => {
    olderNote(history(2, 2));
    rebuildContextItems(AGENT);
    model.refuseCall = 2;   // the second conversation's chunk is refused
    const first = await runSummaryRebuildBatch();
    expect(first.legacy?.waiting[AGENT]).toMatch(/refused/);
    expect(live().map((r) => r.rebuild_state)).toEqual(['legacy_mixed_rebuild']);
    expect(await viewOf()).toMatch(/older mixed notes/);
    expect((db().prepare('SELECT COUNT(*) AS k FROM summary_rebuild_staged').get() as { k: number }).k).toBe(1);
    // The refusal benched the writer until something changes; a provider answering is one such change.
    __resetSummaryWriterHealthForTests();
    model.calls = []; model.refuseCall = 0;
    await runSummaryRebuildBatch();
    expect(model.calls, 'only the chunk that had not landed is dialled').toHaveLength(1);
    expect(live()).toHaveLength(2);
    expect((db().prepare('SELECT COUNT(*) AS k FROM summary_rebuild_staged').get() as { k: number }).k).toBe(0);
  });

  it('downgrade, then upgrade: notes an older version wrote in between (one condensing a queued note) are labelled and rebuilt', async () => {
    olderNote(history(2, 2));
    rebuildContextItems(AGENT);
    await runSummaryRebuildBatch();          // the upgrade's first run: rebuilt
    expect(live()).toHaveLength(2);
    // Downgraded: an older version writes a mixed leaf and condenses it with a fresh one, labelling nothing.
    const a = olderNote(history(2, 1));
    const b = olderNote(history(2, 1));
    const parent = createCondensedSummary(AGENT, 'Older version condensed two mixed notes.', 300, [a, b], 1, new Date().toISOString(), new Date().toISOString());
    db().prepare('UPDATE summaries SET subject_key = NULL, rebuild_state = NULL WHERE id = ?').run(parent.id);
    rebuildContextItems(AGENT);
    // Upgraded again: the job labels what nobody labelled, queues the recent mixed parent, rebuilds it.
    const stats = await runSummaryRebuildBatch();
    expect(stats.legacy?.classified).toBeGreaterThan(0);
    expect(live().every((r) => r.rebuild_state === null && r.subject_key?.startsWith('conv:'))).toBe(true);
    expect((db().prepare('SELECT COUNT(*) AS k FROM summaries WHERE id IN (?, ?, ?)').get(a, b, parent.id) as { k: number }).k).toBe(0);
  });

  it('a conversation deleted while its rebuild was queued: the rest is rebuilt; nothing points at a deleted row', async () => {
    olderNote(history(2, 2));
    rebuildContextItems(AGENT);
    model.refuseCall = 2;
    await runSummaryRebuildBatch();          // one conversation staged, the other refused
    db().prepare('DELETE FROM messages WHERE conversation_id = ?').run(MAIL);
    __resetSummaryWriterHealthForTests();
    model.refuseCall = 0;
    await runSummaryRebuildBatch();
    const rows = live();
    expect(rows.map((r) => r.subject_key)).toEqual([`conv:${DASH}`]);
    const dangling = (db().prepare('SELECT COUNT(*) AS k FROM summary_messages sm WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = sm.message_id)').get() as { k: number }).k;
    expect(dangling).toBe(0);
  });

  it('every source row gone: the note keeps its content, labelled "conversation unknown", and is never dialled', async () => {
    olderNote(history(1, 2), 'Note whose rows were all deleted.');
    db().prepare('DELETE FROM messages WHERE agent_id = ?').run(AGENT);
    rebuildContextItems(AGENT);
    await runSummaryRebuildBatch();
    expect(model.calls).toHaveLength(0);
    const row = db().prepare('SELECT rebuild_state, content FROM summaries WHERE agent_id = ?').get(AGENT) as { rebuild_state: string; content: string };
    expect(row).toEqual({ rebuild_state: 'lineage_lost', content: 'Note whose rows were all deleted.' });
    expect(await viewOf()).toMatch(/conversation=\\"conversation unknown, /);
  });
});

const OTHER = 'agent-t144-zzz';   // sorts after AGENT: the pass reaches it second
const OTHER_CONVS: [string, string] = ['conv-t144-z-dash', 'conv-t144-z-mail'];
function seedOther(): string {
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Second Reader', 'idle', ?, '{}')").run(OTHER, WRITER);
  const conv = db().prepare('INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name) VALUES (?, ?, ?, ?, ?, ?)');
  conv.run(OTHER_CONVS[0], OTHER, 'dashboard', null, 'owner', null);
  conv.run(OTHER_CONVS[1], OTHER, 'email', 'gmail', 'second@depot.example', 'Second Dispatch');
  return olderNote(history(2, 2, OTHER, OTHER_CONVS), 'Second agent mixed note.', OTHER);
}
const liveFor = (agent: string): number =>
  (db().prepare("SELECT COUNT(*) AS k FROM summaries s JOIN context_items ci ON ci.item_id = s.id WHERE ci.agent_id = ? AND ci.item_type = 'summary' AND s.subject_key LIKE 'conv:%'").get(agent) as { k: number }).k;

describe('t144 round 2 — one agent\'s failure never starves the others (I1)', () => {
  it('a throw while swapping the first agent is logged against it; the second agent is still rebuilt', async () => {
    olderNote(history(2, 2));
    seedOther();
    rebuildContextItems(AGENT); rebuildContextItems(OTHER);
    fault.leafFor = AGENT;
    const stats = await runSummaryRebuildBatch();
    expect(stats.legacy?.waiting[AGENT]).toMatch(/simulated defect row/);
    expect(liveFor(OTHER)).toBe(2);
    expect(stats.legacy?.agentsSwapped).toBe(1);
    expect(live().map((r) => r.rebuild_state)).toEqual(['legacy_mixed_rebuild']);   // the failed agent keeps its labelled note
  });
});

describe('t144 round 2 — covered rows and rows in view change together (I4)', () => {
  it('a crash right after the swap leaves the older note in view and every row covered once; the next run finishes without paying again', async () => {
    const ids = history(2, 2);
    olderNote(ids);
    rebuildContextItems(AGENT);
    fault.contextItemsOnce = true;
    const first = await runSummaryRebuildBatch();
    expect(first.legacy?.waiting[AGENT]).toMatch(/simulated crash/);
    for (const id of ids) expect(coverCount(id), `${id} is covered AND in view`).toBe(1);
    expect(live().map((r) => r.rebuild_state)).toEqual(['legacy_mixed_rebuild']);
    const paid = model.calls.length;
    await runSummaryRebuildBatch();
    expect(model.calls.length, 'the staged chunks are not paid for twice').toBe(paid);
    expect(live()).toHaveLength(2);
    for (const id of ids) expect(coverCount(id), id).toBe(1);
  });
});
