// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 owner test 2, fix rank 1 (DIAGNOSIS-test2.md, Problems 1 and 3): THE MODEL SEES WHAT IT SAID BESIDE A TOOL CALL.
//
// The field run: one turn, many rounds. Each round the model wrote a line beside a tool call ("On it ...", then three
// near-identical "A few things to flag" lists). The engine demoted each line to a `[working-note]` row (owner ruling
// 2026-07-10: demote, don't discard), `role='system'` by its own contract, and stored the assistant row with the
// `tool_use` blocks only. The model never saw its own words again, so it said them again: T52's recorded root
// (`post-call-classify/terminal-text.ts`, "The model's own answer was erased from the only record the model reads").
//
// THE FIX, at the one reader the model has (the assembler's tail): a working note the engine demoted from a round is
// the text of that round's own assistant row, so it is rendered there, ahead of the row's `tool_use` blocks. The
// stored rows do not change, so the owner's display (the dimmed note, the live conversion) and every reader of
// assistant text (the reply floors, the routing, the settlement) are untouched; only the model-facing history gains
// the words, once. A note the engine RETIRED because it delivered the same words as the answer is not rendered.
//
// Writers are the real ones `terminal-text.ts` and `persist-assistant.ts` call. Fixture text invented.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX } from '@dojo/shared';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

import { assembleContext } from '../assembler.js';
import { insertMessageIfAbsent, insertMessage, retireById } from '../message-store.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-own-words';
const MODEL = 'own-words-model';
const TURN = 7;
let n = 0;

function seed(): void {
  const db = mockDb.current!;
  db.prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','https://api.example.com')").run();
  db.prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
              VALUES (?, 'p', 'own-words', 'Own Words', 128000, 4096, '["tools"]')`).run(MODEL);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Own Words', 'idle', ?, '{}')").run(AGENT, MODEL);
}

/** One round as the engine writes it: the demoted note (terminal-text), then the tool_use row (persist-assistant),
 *  then the tool result. Returns the note's id. */
function round(narration: string, opts: { internal?: boolean } = {}): string {
  n += 1;
  const noteId = `note-${n}`;
  insertMessageIfAbsent({ id: noteId, agentId: AGENT, role: 'system', content: `${opts.internal ? INTERNAL_WORKING_NOTE_PREFIX : WORKING_NOTE_PREFIX}${narration}`, turnNumber: TURN });
  insertMessageIfAbsent({ id: `use-${n}`, agentId: AGENT, role: 'assistant', content: JSON.stringify([{ type: 'tool_use', id: `call-${n}`, name: 'user_gmail_search', input: { q: `label:${n}` } }]), turnNumber: TURN });
  insertMessage({ id: `res-${n}`, agentId: AGENT, role: 'tool', content: JSON.stringify([{ type: 'tool_result', tool_use_id: `call-${n}`, content: `${n} results` }]), turnNumber: TURN });
  return noteId;
}

type Block = { type: string; text?: string; id?: string };
type Msg = { role: string; content: string | Block[] };
const assistantWith = (msgs: Msg[], callId: string): Msg | undefined =>
  msgs.find((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' && b.id === callId));
const everywhere = (msgs: Msg[], s: string): number => msgs.reduce((c, m) => c + (JSON.stringify(m.content).split(s).length - 1), 0);

beforeEach(() => {
  n = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seed();
  insertMessage({ id: 'ask', agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: 'Label and archive the receipts from last week.', turnNumber: TURN });
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a line the model wrote beside a tool call is in its own assistant turn on the next round', () => {
  it('round 2 sees the round-1 narration inside the round-1 assistant message, ahead of its tool call, exactly once', async () => {
    round('On it, looking for the receipts now.');
    const ctx = await assembleContext(AGENT, MODEL);
    const msgs = ctx.messages as Msg[];
    const r1 = assistantWith(msgs, 'call-1');
    expect(r1, 'the round-1 assistant message is in view').toBeTruthy();
    const blocks = r1!.content as Block[];
    const textAt = blocks.findIndex((b) => b.type === 'text' && (b.text ?? '').includes('On it, looking for the receipts now.'));
    const useAt = blocks.findIndex((b) => b.type === 'tool_use');
    expect(textAt, 'the model sees what it said').toBeGreaterThanOrEqual(0);
    expect(textAt).toBeLessThan(useAt);
    expect(everywhere(msgs, 'On it, looking for the receipts now.'), 'one copy in the model-facing history').toBe(1);
    expect(everywhere(msgs, '[working-note'), 'never the engine wrapper').toBe(0);
  });

  it('three rounds: round 3 sees both earlier lists, each once (Problem 3)', async () => {
    round('A few things to flag: the title is required.');
    round('A few things to flag: the label is missing.');
    const msgs = (await assembleContext(AGENT, MODEL)).messages as Msg[];
    expect(everywhere(msgs, 'the title is required')).toBe(1);
    expect(everywhere(msgs, 'the label is missing')).toBe(1);
    expect(JSON.stringify(assistantWith(msgs, 'call-2')!.content)).toContain('the label is missing');
  });

  it('an internal note (a routed-channel or unattended turn) is still the model\'s own words', async () => {
    round('Checking the second inbox.', { internal: true });
    const msgs = (await assembleContext(AGENT, MODEL)).messages as Msg[];
    expect(JSON.stringify(assistantWith(msgs, 'call-1')!.content)).toContain('Checking the second inbox.');
  });

  it('a note the engine retired because it delivered the same words as the answer is not rendered (one copy)', async () => {
    const noteId = round('Done: 12 receipts labelled and archived.');
    insertMessageIfAbsent({ id: 'recovered', agentId: AGENT, role: 'assistant', content: 'Done: 12 receipts labelled and archived.', turnNumber: TURN });
    retireById(noteId);
    const msgs = (await assembleContext(AGENT, MODEL)).messages as Msg[];
    expect(everywhere(msgs, 'Done: 12 receipts labelled and archived.')).toBe(1);
  });

  it('the stored rows are untouched (the display and every reader of assistant text see what they saw)', async () => {
    round('On it.');
    await assembleContext(AGENT, MODEL);
    const rows = mockDb.current!.prepare("SELECT id, role, content FROM messages WHERE agent_id = ? AND id IN ('note-1','use-1') ORDER BY seq").all(AGENT) as Array<{ id: string; role: string; content: string }>;
    expect(rows[0]).toMatchObject({ id: 'note-1', role: 'system', content: `${WORKING_NOTE_PREFIX}On it.` });
    expect(JSON.parse(rows[1].content)).toEqual([{ type: 'tool_use', id: 'call-1', name: 'user_gmail_search', input: { q: 'label:1' } }]);
  });

  it('cache: a later round leaves every earlier message byte-identical, and the system prompt is unchanged', async () => {
    round('On it.');
    const first = await assembleContext(AGENT, MODEL);
    round('Still going.');
    const second = await assembleContext(AGENT, MODEL);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    const earlier = (first.messages as Msg[]).slice(0, (first.messages as Msg[]).length - 1);   // the tail's last row may carry the end marker
    for (let i = 0; i < earlier.length; i++) expect(JSON.stringify((second.messages as Msg[])[i])).toBe(JSON.stringify(earlier[i]));
  });

  it('CONTROL: a tool-use round with no narration renders exactly as before (no text block invented)', async () => {
    insertMessageIfAbsent({ id: 'use-x', agentId: AGENT, role: 'assistant', content: JSON.stringify([{ type: 'tool_use', id: 'call-x', name: 'user_gmail_search', input: {} }]), turnNumber: TURN });
    insertMessage({ id: 'res-x', agentId: AGENT, role: 'tool', content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'call-x', content: 'ok' }]), turnNumber: TURN });
    const msgs = (await assembleContext(AGENT, MODEL)).messages as Msg[];
    const blocks = assistantWith(msgs, 'call-x')!.content as Block[];
    expect(blocks.filter((b) => b.type === 'text' && !(b.text ?? '').startsWith('['))).toEqual([]);
  });
});
