// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 T6 — the assembly's SHAPE, against the real migration chain.
//
// Two subjects, both RED at T6's base commit (`694fb96`):
//
//  1. `messageEntryIds` IS POPULATED (F21). At the base commit the field is declared on
//     `AssembledContext`, read by the receipt, passed by the loop, and assigned by NOTHING
//     — `git grep` returns five hits and not one of them is a write. Every clause below
//     that reads a lane id therefore returned `undefined`.
//
//  2. THE PM PATH RETURNS THE SAME SHAPE (F22), and its day-0 defect is closed. The PM
//     branch ended at `while (messages[0].role !== 'user') messages.shift()` and returned:
//     ROLE normalised, leading `tool_result` NOT. A first message that is a user message
//     whose blocks are all tool_result satisfies that loop exactly, and Anthropic rejects
//     it — 3 of the detect window's 17 day-0 divergences, all on `kelly`
//     (`first-message-leads-with-tool-result`).
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

import { assembleContext } from '../assembler.js';
import { validateAssembly } from '../assembly-validation.js';
import { runMigrations } from '../../db/migrations.js';

const PM = 'pm';                       // config/platform.ts: `pm_agent_id` defaults to 'pm'
const ORDINARY = 'agent-shape-plain';
const MODEL = 'shape-model';

function seedModel(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'shape', 'Shape', 128000, 4096, '["tools"]')`,
  ).run(MODEL);
}

function seedAgent(id: string, name: string): void {
  mockDb.current!.prepare(
    "INSERT INTO agents (id, name, status, model_id, config) VALUES (?, ?, 'idle', ?, '{}')",
  ).run(id, name, MODEL);
}

let seq = 0;
function row(agentId: string, role: string, content: string, turn: number): void {
  seq += 1;
  const kind = role === 'assistant' ? 'agent-text' : content.startsWith('[{') ? 'tool-turn' : 'user-text';
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, created_at)
     VALUES (?, ?, ?, 'owner', 'owner', ?, ?, 'user-visible', ?, 'live', 1, ?)`,
  ).run(`shape-${seq}`, agentId, role, content, kind, turn, 1785000000000 + seq * 1000);
}

/** The exact shape the PM defect needs: history whose OLDEST surviving row is a pure
 *  `tool_result` carrier, i.e. a user-role message that the old `while` loop accepts. */
function seedLeadingToolResult(agentId: string): void {
  row(agentId, 'assistant', JSON.stringify([{ type: 'tool_use', id: 'call_x', name: 'work_open', input: {} }]), 1);
  row(agentId, 'user', JSON.stringify([{ type: 'tool_result', tool_use_id: 'call_x', content: '[FILED] ok' }]), 1);
  row(agentId, 'assistant', 'Filed it.', 1);
  row(agentId, 'user', 'thanks', 2);
}

beforeEach(() => {
  seq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedModel();
  seedAgent(PM, 'PM');
  seedAgent(ORDINARY, 'Plain');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('F21 — messageEntryIds is populated', () => {
  it('every assembled message carries the lane that produced it, aligned to the array', async () => {
    row(ORDINARY, 'user', 'what is the plan?', 1);
    row(ORDINARY, 'assistant', 'here it is', 1);
    row(ORDINARY, 'user', 'thanks', 2);

    const ctx = await assembleContext(ORDINARY, MODEL);

    expect(Array.isArray(ctx.messageEntryIds)).toBe(true);
    expect(ctx.messageEntryIds).toHaveLength(ctx.messages.length);
    // Not merely present — actually assigned. The dead-plumbing state was an array of
    // nulls being indistinguishable from no array at all.
    expect(ctx.messageEntryIds!.filter((x) => x !== null).length).toBeGreaterThan(0);
    expect(ctx.messageEntryIds).toContain('lane.fresh-tail');
  });

  it('every id it reports is a lane the allocator ALSO reported a grant for', async () => {
    row(ORDINARY, 'user', 'hello', 1);
    row(ORDINARY, 'assistant', 'hi', 1);
    row(ORDINARY, 'user', 'again', 2);

    const ctx = await assembleContext(ORDINARY, MODEL);
    const granted = new Set((ctx.allocation?.grants ?? []).map((g) => g.id));
    for (const id of ctx.messageEntryIds ?? []) {
      if (id === null) continue;
      expect(granted, `lane "${id}" tagged a message but has no grant in the report`).toContain(id);
    }
  });

  it('THE TAG NEVER REACHES THE WIRE — the serialized array is byte-identical to an untagged copy', async () => {
    row(ORDINARY, 'user', 'hello', 1);
    row(ORDINARY, 'assistant', 'hi', 1);
    row(ORDINARY, 'user', 'again', 2);

    const ctx = await assembleContext(ORDINARY, MODEL);
    const stripped = ctx.messages.map((m) => ({ role: m.role, content: m.content }));
    expect(JSON.stringify(ctx.messages)).toBe(JSON.stringify(stripped));
  });
});

describe('F22 — the PM path returns the same shape', () => {
  it('carries every field the ordinary path carries', async () => {
    row(PM, 'user', 'status?', 1);
    row(PM, 'assistant', 'all good', 1);
    row(PM, 'user', 'thanks', 2);

    const pm = await assembleContext(PM, MODEL);

    expect(pm.messages.length).toBeGreaterThan(0);
    expect(pm.messageEntryIds).toHaveLength(pm.messages.length);
    expect(pm.messageEntryIds).toContain('lane.pm-tail');
    expect(typeof pm.freshTailDropped).toBe('number');
    expect(typeof pm.reserveTokens).toBe('number');
    expect(pm.systemVolatile).toBe('');
    expect(pm.allocation).toBeDefined();
    // The report is not a stub: it names the lane, its cost, and its reason in words.
    const grant = pm.allocation!.grants.find((g) => g.id === 'lane.pm-tail');
    expect(grant).toBeDefined();
    expect(grant!.reason).toMatch(/tracker is its memory/);
    expect(grant!.granted).toBeGreaterThan(0);
    expect(pm.allocation!.admittedIds).toEqual(['lane.pm-tail']);
  });

  // ── the day-0 defect, both halves ──
  it('THE DEFECT: a leading pure tool_result survives ROLE normalisation, which is what the old branch did', () => {
    // The old branch's entire head repair, verbatim. It is shown here rather than
    // described so the reason the fix is `applyIntegrityPass` is visible: this loop is a
    // strictly weaker copy of that pass's FIRST clause.
    const messages = [
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'call_x', content: 'ok' }] },
      { role: 'assistant' as const, content: 'Filed it.' },
    ];
    while (messages.length > 0 && messages[0].role !== 'user') messages.shift();
    expect(messages[0].role).toBe('user');                       // the loop is satisfied…
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect((messages[0].content as Array<{ type: string }>).every((b) => b.type === 'tool_result')).toBe(true);
    // …and the provider rejects exactly this.
    expect(validateAssembly(messages, { budgetTokens: 10_000 }).violations.map((v) => v.code))
      .toContain('first-message-leads-with-tool-result');
  });

  it('THE FIX: the PM assembly passes validateAssembly on the same history', async () => {
    seedLeadingToolResult(PM);
    const pm = await assembleContext(PM, MODEL);

    const result = validateAssembly(pm.messages, { budgetTokens: 100_000 });
    expect(result.violations.map((v) => v.code)).not.toContain('first-message-leads-with-tool-result');
    expect(result.violations.map((v) => v.code)).not.toContain('tool-result-without-use');
  });

  it('the PM path and the ordinary path agree on the head clause for the same history', async () => {
    seedLeadingToolResult(PM);
    seedLeadingToolResult(ORDINARY);

    const pm = await assembleContext(PM, MODEL);
    const plain = await assembleContext(ORDINARY, MODEL);

    const headIsUserText = (msgs: typeof pm.messages) => {
      const first = msgs[0];
      if (!first) return true;
      if (first.role !== 'user') return false;
      if (!Array.isArray(first.content)) return true;
      return !first.content.every((b) => (b as { type?: string }).type === 'tool_result');
    };
    expect(headIsUserText(pm.messages)).toBe(true);
    expect(headIsUserText(plain.messages)).toBe(true);
  });
});
