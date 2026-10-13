// ════════════════════════════════════════════════════════════════════════════════════════
// t144 — ONE CONVERSATION PER CONDENSED NOTE, DATED FROM THE RECORD, LABELLED IN VIEW.
//
// Tracker #12 RC3 and OR-V333-SET (8). The owner: "The agent just needs to be aware of what
// conversations are what and not confuse them." (OR-LABEL-NOT-HIDE.) The condensing engine chunked
// an agent's rows AGENT-WIDE — an owner's dashboard request and an email thread's notices landed in
// one summary — fed the summariser no per-message time (so it wrote "date unknown"), told it every
// `[USER]` was "the human operator", asked it to carry "pending tasks" (a second record of what is
// current, OR-TRACKER-1), and rendered the note with no conversation on it.
//
// THE DOORS: a migrated DB; the real compaction entry (`checkAndCompact` with the leaving span the
// gate computes), the real condenser (`condenseUntilFits`), the real assembler, the real nightly job
// (`runSummaryRebuildBatch`). Only the model is scripted: it records what it was sent.
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
  calls: [] as Array<{ systemPrompt: string; content: string }>,
  /** A row marker whose presence in the input makes the writer answer empty (a refusal). */
  refuseWhen: null as string | null,
  written: 0,
  /** The window the assembler is told the agent's model has. */
  window: 32_000,
}));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { systemPrompt: string; messages: Array<{ content: string }> }) => {
    const content = String(p.messages[0]?.content ?? '');
    model.calls.push({ systemPrompt: p.systemPrompt, content });
    if (model.refuseWhen && content.includes(model.refuseWhen)) return { content: '', toolCalls: [], usage: {} };
    model.written++;
    return { content: `Note ${model.written}: the depot crew logged the seals and filed the manifests.`, toolCalls: [], usage: {} };
  },
  getContextWindow: () => model.window,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { checkAndCompact, rebuildContextItems } from '../compaction.js';
import { condenseUntilFits } from '../condense-until-fits.js';
import { createLeafSummary } from '../dag.js';
import { assembleContext } from '../assembler.js';
import { renderInstant } from '../message-stamp.js';
import { runSummaryRebuildBatch } from '../summary-rebuild.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';
import { __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { backgroundDrains } from '../../agent/shared-state.js';

const AGENT = 'agent-t144-depot';
const WRITER = 'model-t144-writer';
const DASH = 'conv-t144-dashboard';
const MAIL = 'conv-t144-mail';
const db = (): Database.Database => mockDb.current!;
const T0 = Date.UTC(2026, 9, 1, 15, 0, 0);   // Oct 1, 2026 — every row's recorded instant is T0 + n minutes

function seed(): void {
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-t144', 'Local', 'openai-compatible', 'api_key', 'http://localhost:11434/v1')").run();
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
                VALUES (?, 'p-t144', 'writer', 'Writer', 32000, 4096, '["text","tools"]', 1, 0.1, 0.4)`).run(WRITER);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, WRITER);
  const conv = db().prepare('INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name) VALUES (?, ?, ?, ?, ?, ?)');
  conv.run(DASH, AGENT, 'dashboard', null, 'owner', null);
  conv.run(MAIL, AGENT, 'email', 'gmail', 'dispatch@depot.example', 'Depot Dispatch');
}

let n = 0;
/** One exchange in a conversation: the inbound row and the agent's reply, each with its own instant. */
function exchange(conv: string, body: string): void {
  const k = conv === DASH ? 'a' : 'b';
  n++;
  const inbound = insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', conversationId: conv, turnNumber: n,
    channel: conv === DASH ? 'dashboard' : 'email', senderId: conv === DASH ? 'owner' : 'dispatch@depot.example',
    authorized: conv === DASH, content: `[${k}${n}] ${body}`,
  });
  const reply = insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', conversationId: conv, turnNumber: n, content: `[${k}${n}r] Noted: ${body}` });
  db().prepare("UPDATE messages SET created_at = ?, subject_kind = CASE role WHEN 'assistant' THEN 'conv' ELSE NULL END WHERE seq = ?").run(T0 + n * 120_000, inbound.seq);
  db().prepare("UPDATE messages SET created_at = ?, subject_kind = 'conv' WHERE seq = ?").run(T0 + n * 120_000 + 60_000, reply.seq);
}

/** Interleaved traffic: the owner's requests and an email thread's notices, alternating. */
function interleave(pairs: number, body = 'Check the seal on crate 7 and log the bay.'): void {
  for (let i = 0; i < pairs; i++) {
    exchange(DASH, body);
    exchange(MAIL, body);
  }
}

/** The conversations a summary's own source rows belong to. */
function conversationsOf(summaryId: string): string[] {
  return (db().prepare(`SELECT DISTINCT m.conversation_id AS c FROM summary_messages sm JOIN messages m ON m.id = sm.message_id
                         WHERE sm.summary_id = ? ORDER BY 1`).all(summaryId) as Array<{ c: string }>).map((r) => r.c);
}
const leaves = (): Array<{ id: string }> =>
  db().prepare("SELECT id FROM summaries WHERE agent_id = ? AND depth = 0 ORDER BY earliest_at, id").all(AGENT) as Array<{ id: string }>;
const seqOf = (marker: string): number =>
  (db().prepare('SELECT seq FROM messages WHERE agent_id = ? AND content LIKE ?').get(AGENT, `${marker} %`) as { seq: number }).seq;

/** Fold every unsummarised row through `marker`'s row — the span the gate hands the leaving-view pass. */
async function foldThrough(marker: string): Promise<void> {
  const throughSeq = seqOf(marker);
  await checkAndCompact(AGENT, WRITER, 32_000, { leaving: { cause: 'full', throughSeq, rowsLeaving: throughSeq } });
}

/** Every row the assembled view neither shows nor stands for with a summary in view. */
function lostRows(view: string): string[] {
  const rows = db().prepare('SELECT id, content FROM messages WHERE agent_id = ? ORDER BY seq').all(AGENT) as Array<{ id: string; content: string }>;
  // A row is stood for by its leaf or by any summary that condensed it, however deep.
  const cover = db().prepare(`WITH RECURSIVE up(id) AS (SELECT summary_id FROM summary_messages WHERE message_id = ?
                                UNION SELECT sp.summary_id FROM summary_parents sp JOIN up ON sp.parent_id = up.id)
                              SELECT s.content AS content FROM summaries s JOIN up ON up.id = s.id`);
  const lost: string[] = [];
  for (const r of rows) {
    const marker = /^\[[ab]\d+r?\]/.exec(r.content)?.[0];
    if (!marker || view.includes(marker)) continue;
    const covers = cover.all(r.id) as Array<{ content: string }>;
    if (!covers.some((c) => view.includes(c.content.slice(0, 40)))) lost.push(marker);
  }
  return lost;
}
const viewText = (a: Awaited<ReturnType<typeof assembleContext>>): string =>
  JSON.stringify(a.messages) + String((a as { systemPrompt?: string }).systemPrompt ?? '');

beforeEach(() => {
  n = 0;
  model.calls = [];
  model.refuseWhen = null;
  model.written = 0;
  model.window = 32_000;
  backgroundDrains.clear();
  __resetBrakesForTests();
  __resetBreakersForTests();
  __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  seed();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t144 — a condensed note never crosses conversations', () => {
  it.fails('W1: two interleaved conversations folded together give notes of ONE conversation each', async () => {
    interleave(40);
    await foldThrough('[b60]');
    const written = leaves();
    expect(written.length).toBeGreaterThan(0);
    for (const s of written) expect(conversationsOf(s.id), `summary ${s.id}`).toHaveLength(1);
    // Both conversations were folded: nothing was dropped to make the notes single-subject.
    const covered = new Set(written.flatMap((s) => conversationsOf(s.id)));
    expect([...covered].sort()).toEqual([DASH, MAIL].sort());
  });

  it.fails('W2: the summariser is given every message\'s recorded time (no "date unknown" from a lack of input)', async () => {
    interleave(40);
    await foldThrough('[b60]');
    expect(model.calls.length).toBeGreaterThan(0);
    for (const call of model.calls) {
      for (const block of call.content.split('\n\n---\n\n')) {
        const marker = /\[([ab]\d+r?)\]/.exec(block)?.[0];
        if (!marker) continue;
        const at = (db().prepare('SELECT created_at FROM messages WHERE agent_id = ? AND content LIKE ?').get(AGENT, `${marker} %`) as { created_at: number }).created_at;
        expect(block, `${marker} carries its recorded instant`).toContain(renderInstant(at)!);
      }
    }
  });

  it.fails('W3: the summariser is not told every [USER] is the operator, and is not asked to carry pending tasks', async () => {
    interleave(40);
    await foldThrough('[b60]');
    const prompts = model.calls.map((c) => c.systemPrompt).join('\n');
    expect(prompts).not.toMatch(/human operator/i);
    expect(prompts).not.toMatch(/pending task/i);
  });

  it.fails('W4: every note in view carries the ONE conversation it belongs to', async () => {
    interleave(40);
    await foldThrough('[b60]');
    const view = viewText(await assembleContext(AGENT, WRITER));
    const tags = view.match(/<summary [^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toMatch(/conversation=\\?"(dashboard conversation with [^"\\]+|email thread with Depot Dispatch[^"\\]*)\\?"/);
  });

  it.fails('W5: condensation merges a conversation\'s notes with its own, carrying the label into the writer\'s input', async () => {
    interleave(8);
    const rows = db().prepare('SELECT id, conversation_id AS c, created_at AS at FROM messages WHERE agent_id = ? ORDER BY seq').all(AGENT) as Array<{ id: string; c: string; at: number }>;
    // Four leaves, two per conversation, written as the post-fix fold writes them (one conversation each).
    for (const conv of [DASH, MAIL]) {
      const mine = rows.filter((r) => r.c === conv);
      for (const half of [mine.slice(0, mine.length / 2), mine.slice(mine.length / 2)]) {
        createLeafSummary(AGENT, `Leaf of ${conv}: seals logged.`, 600, half.map((r) => r.id), new Date(half[0].at).toISOString(), new Date(half[half.length - 1].at).toISOString());
      }
    }
    let measured = 0;
    await condenseUntilFits({
      agentId: AGENT, modelId: WRITER, minFanout: 4, targetTokens: 1000,
      measure: async () => ({ total: 10_000, summaryTokens: measured++ === 0 ? 0 : 1e9 }),
      rebuild: () => rebuildContextItems(AGENT),
    });
    const parents = db().prepare("SELECT id FROM summaries WHERE agent_id = ? AND depth = 1").all(AGENT) as Array<{ id: string }>;
    expect(parents.length).toBe(2);
    for (const p of parents) {
      const convs = (db().prepare(`SELECT DISTINCT m.conversation_id AS c FROM summary_parents sp JOIN summary_messages sm ON sm.summary_id = sp.parent_id
                                     JOIN messages m ON m.id = sm.message_id WHERE sp.summary_id = ?`).all(p.id) as Array<{ c: string }>);
      expect(convs, `parent ${p.id}`).toHaveLength(1);
    }
    for (const call of model.calls) expect(call.content).toMatch(/conversation="(dashboard conversation with|email thread with Depot Dispatch)/);
  });
});

describe('t144 — membership: a fold never leaves a row out of view that nothing stands for', () => {
  it.fails('W6: one conversation\'s chunk refused while another\'s lands — every row is in view or covered in view', async () => {
    // Long rows: the span is several chunks whatever the chunking, so a refusal can sit below a success.
    interleave(40, 'Crate manifest: bay, weight, seal number, inspector initials and remarks for the night shift. '.repeat(45));
    model.refuseWhen = '[b2]';   // the writer answers empty on the chunk holding the email thread's first notice
    await foldThrough('[b60]');
    expect(model.written).toBeGreaterThan(0);   // something did land above the refused rows
    model.window = 1_000_000;   // the view is roomy: only the fold, never the token trim, decides what is out of view
    const view = viewText(await assembleContext(AGENT, WRITER));
    expect(lostRows(view)).toEqual([]);
  });
});

describe('t144 — the rebuild of mixed notes from before the update', () => {
  it.fails('W7: a mixed note from the last two weeks is rebuilt by the nightly job into one note per conversation', async () => {
    interleave(6);
    const now = Date.now();
    db().prepare('UPDATE messages SET created_at = ? + seq * 60000 WHERE agent_id = ?').run(now - 3 * 86_400_000, AGENT);
    const all = db().prepare('SELECT id FROM messages WHERE agent_id = ? ORDER BY seq').all(AGENT) as Array<{ id: string }>;
    // A note written before the update: agent-wide, both conversations in one summary.
    const legacy = createLeafSummary(AGENT, 'Mixed: the owner asked about seals; dispatch emailed about bays.', 400,
      all.map((r) => r.id), new Date(now - 3 * 86_400_000).toISOString(), new Date(now - 2 * 86_400_000).toISOString());
    db().prepare("UPDATE summaries SET created_at = datetime('now', '-2 days') WHERE id = ?").run(legacy.id);
    for (const c of ['subject_key', 'rebuild_state']) {
      if ((db().prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('summaries', c))) db().prepare(`UPDATE summaries SET ${c} = NULL`).run();
    }
    rebuildContextItems(AGENT);
    await runSummaryRebuildBatch();
    const live = db().prepare(`SELECT s.id FROM summaries s JOIN context_items ci ON ci.item_id = s.id WHERE ci.agent_id = ?`).all(AGENT) as Array<{ id: string }>;
    expect(live.length).toBe(2);
    for (const s of live) expect(conversationsOf(s.id)).toHaveLength(1);
    // Every source row is covered by exactly one live summary.
    for (const r of all) {
      const k = (db().prepare('SELECT COUNT(*) AS k FROM summary_messages WHERE message_id = ?').get(r.id) as { k: number }).k;
      expect(k, r.id).toBe(1);
    }
  });
});
