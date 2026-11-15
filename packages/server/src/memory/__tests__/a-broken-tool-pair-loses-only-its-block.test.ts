// A tool call with no result, or a result with no call, loses only that block in the assembled context:
// the agent's text and every other row stay in view, a result row is moved next to its call, and the
// request each provider shape is sent carries no unpaired tool block.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { assembleContext } from '../assembler.js';
import { unpairedToolIds, type PairedMessage } from '../../agent/tool-pairing.js';
import { buildOpenAIMessages, buildNativeOllamaMessages } from '../../agent/model.js';
import { contractForModel } from '../../agent/model-contract.js';

const AGENT = 'primary';
let image: Buffer | null = null;
function freshDb(): Database.Database {
  if (!image) {
    const s = new Database(':memory:');
    mockDb.current = s;
    runMigrations();
    image = s.serialize();
    s.close();
  }
  return new Database(image);
}

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')").run();
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
              VALUES ('conv-dash', 'primary', 'dashboard', NULL, 'owner', datetime('now'))`).run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

type Block = Record<string, unknown>;
const use = (id: string): Block => ({ type: 'tool_use', id, name: 'file_read', input: { path: `/${id}` } });
const result = (id: string): Block => ({ type: 'tool_result', tool_use_id: id, content: `result of ${id}` });
const text = (t: string): Block => ({ type: 'text', text: t });

let n = 0;
function row(role: 'user' | 'assistant' | 'tool', content: string | Block[]): void {
  insertMessage({
    id: `r-${++n}`, agentId: AGENT, role, turnNumber: 1,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
    ...(role === 'user' ? { inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }) } : {}),
  });
}

type Assembled = Awaited<ReturnType<typeof assembleContext>>['messages'];
const assemble = async (): Promise<Assembled> => (await assembleContext(AGENT, 'm')).messages;
const blocksOf = (m: Assembled[number]): Block[] => (Array.isArray(m.content) ? m.content as unknown as Block[] : []);
const all = (ms: Assembled): Block[] => ms.flatMap(blocksOf);
const said = (ms: Assembled): string => JSON.stringify(ms.map((m) => m.content));
const toolIds = (ms: Assembled): string[] =>
  all(ms).filter((b) => b.type === 'tool_use' || b.type === 'tool_result').map((b) => `${b.type}:${String(b.id ?? b.tool_use_id)}`);
const paired = (ms: Assembled): void =>
  expect(unpairedToolIds(ms as unknown as PairedMessage[])).toEqual({ toolUseWithoutResult: [], toolResultWithoutUse: [] });

function unansweredCallWithText(): void {
  row('user', 'please check the file');
  row('assistant', [text('THE-AGENT-SAID-THIS before the call'), use('lost')]);
  row('user', 'any news?');
  row('assistant', 'here is my answer');
}
function partialParallel(): void {
  row('user', 'read both');
  row('assistant', [use('a'), use('b')]);
  row('tool', [result('a')]);
  row('assistant', 'read a, b did not come back');
}
function orphanResult(): void {
  row('user', 'hello');
  row('assistant', 'hi');
  row('tool', [result('ghost')]);
  row('user', 'still there?');
  row('assistant', 'yes');
}

describe('a broken tool pair loses only its block', () => {
  beforeEach(() => { n = 0; });

  it('a. an assistant row with text and an unanswered call keeps its text', async () => {
    unansweredCallWithText();
    const out = await assemble();
    expect(said(out)).toContain('THE-AGENT-SAID-THIS before the call');
    expect(toolIds(out)).toEqual([]);
    expect(said(out)).toContain('here is my answer');
  });

  it('b. a result separated from its call is moved next to it, and the rows between follow', async () => {
    row('user', 'read it');
    row('assistant', [use('x')]);
    row('user', 'BETWEEN-ROW typed while the tool ran');
    row('tool', [result('x')]);
    row('assistant', 'done reading');
    const out = await assemble();
    const at = (pred: (m: Assembled[number]) => boolean): number => out.findIndex(pred);
    const call = at((m) => blocksOf(m).some((b) => b.type === 'tool_use'));
    const answer = at((m) => blocksOf(m).some((b) => b.type === 'tool_result'));
    const between = at((m) => JSON.stringify(m.content).includes('BETWEEN-ROW'));
    expect(answer).toBe(call + 1);
    expect(between).toBeGreaterThanOrEqual(answer);
    expect(toolIds(out)).toEqual(['tool_use:x', 'tool_result:x']);
    expect(said(out)).toContain('done reading');
    paired(out);
  });

  it('c. parallel calls with one result keep the answered pair and strip only the unanswered call', async () => {
    partialParallel();
    const out = await assemble();
    expect(toolIds(out)).toEqual(['tool_use:a', 'tool_result:a']);
    expect(said(out)).toContain('read both');
    expect(said(out)).toContain('read a, b did not come back');
    paired(out);
  });

  it('d. a result with no call anywhere never reaches the model, and the rows around it stay', async () => {
    orphanResult();
    const out = await assemble();
    expect(toolIds(out)).toEqual([]);
    for (const t of ['hello', 'hi', 'still there?', 'yes']) expect(said(out)).toContain(t);
  });

  it('e. a well-formed history renders every row in stored order', async () => {
    row('user', 'read two files');
    row('assistant', [text('reading'), use('a'), use('b')]);
    row('tool', [result('a'), result('b')]);
    row('assistant', [use('c')]);
    row('tool', [result('c')]);
    row('assistant', 'all three read');
    const out = await assemble();
    expect(toolIds(out)).toEqual(['tool_use:a', 'tool_use:b', 'tool_result:a', 'tool_result:b', 'tool_use:c', 'tool_result:c']);
    const order = ['read two files', 'reading', 'result of a', 'result of c', 'all three read'].map((t) => said(out).indexOf(t));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
    paired(out);
  });

  it('f. the same history assembles to identical bytes twice', async () => {
    unansweredCallWithText();
    partialParallel();
    orphanResult();
    expect(JSON.stringify(await assemble())).toBe(JSON.stringify(await assemble()));
  });

  it('g. the request every provider shape is sent carries no unpaired tool block', async () => {
    const contract = contractForModel({ providerBaseUrl: 'https://api.example.com', apiModelId: 'gpt-example' });
    for (const history of [unansweredCallWithText, partialParallel, orphanResult]) {
      mockDb.current?.prepare('DELETE FROM messages').run();
      history();
      const out = await assemble();
      paired(out);   // the Anthropic shape is the assembled array itself
      const msgs = out as Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>;
      const openai = await buildOpenAIMessages('SYS', msgs, AGENT, contract) as unknown as Array<Record<string, unknown>>;
      const calls = openai.flatMap((m) => ((m.tool_calls as Array<{ id: string }> | undefined) ?? []).map((c) => c.id));
      const answers = openai.filter((m) => m.role === 'tool').map((m) => String(m.tool_call_id));
      expect(answers.sort()).toEqual([...calls].sort());
      const ollama = await buildNativeOllamaMessages('SYS', msgs, AGENT) as unknown as Array<Record<string, unknown>>;
      const ollamaCalls = ollama.reduce((k, m) => k + ((m.tool_calls as unknown[] | undefined)?.length ?? 0), 0);
      expect(ollama.filter((m) => m.role === 'tool')).toHaveLength(ollamaCalls);
    }
  });
});
