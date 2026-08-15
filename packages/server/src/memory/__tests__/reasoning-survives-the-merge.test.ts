// ════════════════════════════════════════════════════════════════════════════════════════
// HL8 (B) — REASONING MUST SURVIVE THE CONSECUTIVE-ASSISTANT MERGE.
//
// THE DEFECT, live-measured (W23): `mergeConsecutiveRoles` folded a run of consecutive
// assistant messages by keeping only the FIRST message's fields and merging only `content`
// into it. On one driven five-hop research turn it discarded 1,889 and 2,548 characters of
// `reasoning_content` — both from TOOL-CALL messages, which then reached DeepSeek with the
// `''` fallback. 2 of 6 tool-call assistant messages in the window arrived with empty
// reasoning, and a message corrupted this way stays corrupted on every later hop and every
// later turn, because the loss is at ASSEMBLY, not at persist. The stored rows are intact.
//
// THE ROOT CAUSE IS A TYPE GAP, not a missing line: `reasoningContent` was declared at both
// ENDS of the chain (`LaneMessage`, `ModelCallParams`) and NOWHERE in the middle, so it
// crossed assembly as an undeclared structural extra that TypeScript could not see being
// dropped. Declaring it on `LoopMsg` is what makes the drop a type error.
//
// Both RED clauses reproduce a loss shape measured on the wire, seeded as rows and run
// through the REAL `assembleContext`.
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
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-reasoning-merge';
const MODEL = 'merge-model';

let seq = 0;

function seedModel(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','https://api.deepseek.com')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'deepseek-v4-flash', 'Flash', 128000, 4096, '["tools","thinking"]')`,
  ).run(MODEL);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, ?, 'idle', ?, '{}')")
    .run(AGENT, 'Merge', MODEL);
}

function row(role: string, content: string, turn: number, reasoning: string | null = null): void {
  seq += 1;
  const kind = content.startsWith('[{')
    ? 'tool-turn'
    : role === 'assistant' ? 'agent-text' : role === 'system' ? 'working-note' : 'user-text';
  const tier = role === 'system' ? 'agent-only' : 'user-visible';
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, reasoning_content, created_at)
     VALUES (?, ?, ?, 'owner', 'owner', ?, ?, ?, ?, 'live', 1, ?, ?)`,
  ).run(`merge-${seq}`, AGENT, role, content, kind, tier, turn, reasoning, 1785000000000 + seq * 1000);
}

const toolUse = (id: string): string => JSON.stringify([{ type: 'tool_use', id, name: 'web_search', input: { q: 'x' } }]);
const toolResult = (id: string): string => JSON.stringify([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

type Msg = { role: string; content: unknown; reasoningContent?: string };
const withToolUse = (msgs: Msg[], id: string): Msg | undefined =>
  msgs.find((m) => Array.isArray(m.content)
    && (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_use' && b.id === id));

/** The LAST assistant message. The first one is the engine's own scaffolding ack, which
 *  every assembly emits and which is not what any clause here is about. */
const lastAssistant = (msgs: Msg[]): Msg => [...msgs].reverse().find((m) => m.role === 'assistant')!;

beforeEach(() => {
  seq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedModel();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('HL8 (B) — reasoning survives the consecutive-assistant merge', () => {
  it('RED 1 — THE SPLIT TURN (seq 64123+64124): one model call, two rows, reasoning on the second', async () => {
    // Exactly the measured shape: the text row carries NO reasoning, the `tool_use` row
    // carries 2,548 characters of it, and the pair merges.
    row('user', 'run the three lookups', 1);
    row('assistant', 'On it — running the three lookups now.', 1, null);
    row('assistant', toolUse('call_a'), 1, 'R-TOOLCALL');
    row('tool', toolResult('call_a'), 1);
    row('user', 'and?', 2);

    const ctx = await assembleContext(AGENT, MODEL);
    const merged = withToolUse(ctx.messages as unknown as Msg[], 'call_a');
    expect(merged, 'the tool_use message must be in the assembled array').toBeDefined();
    expect(merged!.reasoningContent).toBe('R-TOOLCALL');
  });

  it('RED 2 — THE SYSTEM-ROW BRIDGE (seq 64037+64111): two turns made adjacent by a row tailRender drops', async () => {
    // A `role='system'` working note sits between two turns. `tailRender` emits only
    // user/assistant/tool, so the previous turn's plain answer and the next turn's first
    // tool call become consecutive assistants and merge. BOTH bodies must come out, in
    // order — a join, not last-wins.
    row('user', 'what boils water', 1);
    row('assistant', 'Water boils at 100 degrees Celsius at sea level.', 1, 'R-PLAIN');
    row('system', '[working-note] engine bookkeeping', 1);
    row('assistant', toolUse('call_b'), 2, 'R-TOOLCALL');
    row('tool', toolResult('call_b'), 2);
    row('user', 'thanks', 3);

    const ctx = await assembleContext(AGENT, MODEL);
    const merged = withToolUse(ctx.messages as unknown as Msg[], 'call_b');
    expect(merged).toBeDefined();
    expect(merged!.reasoningContent).toContain('R-PLAIN');
    expect(merged!.reasoningContent).toContain('R-TOOLCALL');
    expect(merged!.reasoningContent!.indexOf('R-PLAIN'))
      .toBeLessThan(merged!.reasoningContent!.indexOf('R-TOOLCALL'));
  });

  it('CONTROL 1 — an UNMERGED tool-call assistant round-trips its reasoning byte-identically', async () => {
    row('user', 'search', 1);
    row('assistant', toolUse('call_c'), 1, 'R-ALONE');
    row('tool', toolResult('call_c'), 1);
    row('user', 'next', 2);

    const ctx = await assembleContext(AGENT, MODEL);
    expect(withToolUse(ctx.messages as unknown as Msg[], 'call_c')!.reasoningContent).toBe('R-ALONE');
  });

  it('CONTROL 2 — NOTHING IS INVENTED: a merge of two reasoning-free assistants yields undefined, not `\'\'`', async () => {
    row('user', 'hello', 1);
    row('assistant', 'hi', 1, null);
    row('assistant', 'and one more thing', 1, null);
    row('user', 'ok', 2);

    const ctx = await assembleContext(AGENT, MODEL);
    for (const m of ctx.messages) {
      if (m.role !== 'assistant') continue;
      // The `''` fallback stays `model.ts`'s alone — the assembler must not manufacture one.
      expect((m as Msg).reasoningContent).toBeUndefined();
    }
  });

  it('CONTROL 3 — the CONTENT merge is unharmed: both texts survive, in order', async () => {
    row('user', 'hello', 1);
    row('assistant', 'first half', 1, 'R1');
    row('assistant', 'second half', 1, 'R2');
    row('user', 'ok', 2);

    const ctx = await assembleContext(AGENT, MODEL);
    const assistant = lastAssistant(ctx.messages as unknown as Msg[]);
    const text = typeof assistant.content === 'string' ? assistant.content : JSON.stringify(assistant.content);
    expect(text).toContain('first half');
    expect(text).toContain('second half');
    expect(text.indexOf('first half')).toBeLessThan(text.indexOf('second half'));
    // …and the joined reasoning follows the same order.
    expect(assistant.reasoningContent).toBe('R1\n\nR2');
  });

  it('CONTROL 4 — three merged assistants lose nobody (why it is a JOIN and not last-wins)', async () => {
    row('user', 'go', 1);
    row('assistant', 'a', 1, 'RA');
    row('assistant', 'b', 1, 'RB');
    row('assistant', 'c', 1, 'RC');
    row('user', 'ok', 2);

    const ctx = await assembleContext(AGENT, MODEL);
    const assistant = lastAssistant(ctx.messages as unknown as Msg[]);
    expect(assistant.reasoningContent).toBe('RA\n\nRB\n\nRC');
  });
});
