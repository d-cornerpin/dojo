// A tool call with no result, or a result with no call, loses only that block in the assembled context:
// the agent's text and every other row stay in view, a result row is moved next to its call, a row that held
// only an unanswered call leaves no message behind, and the provider request carries no unpaired block.
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
import { repairToolPairing, type PairedMessage } from '../../agent/tool-pairing.js';
import { buildOpenAIMessages } from '../../agent/model.js';
import { contractForModel } from '../../agent/model-contract.js';

let image: Buffer | null = null;
beforeEach(() => {
  if (!image) {
    mockDb.current = new Database(':memory:');
    runMigrations();
    image = mockDb.current.serialize();
  }
  const db = mockDb.current = new Database(image);
  db.exec(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key');
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1);
    INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei');
    INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at) VALUES ('conv-dash', 'primary', 'dashboard', NULL, 'owner', datetime('now'));`);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

type Block = Record<string, unknown>;
const use = (id: string): Block => ({ type: 'tool_use', id, name: 'file_read', input: { path: `/${id}` } });
const result = (id: string): Block => ({ type: 'tool_result', tool_use_id: id, content: `result of ${id}` });
const text = (t: string): Block => ({ type: 'text', text: t });

let n = 0;
function row(role: 'user' | 'assistant' | 'tool' | 'system', content: string | Block[]): void {
  insertMessage({
    id: `r-${++n}`, agentId: 'primary', role, turnNumber: 1, channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
    content: typeof content === 'string' ? content : JSON.stringify(content),
    ...(role === 'user' ? { inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }) } : {}),
  });
}

type Assembled = Awaited<ReturnType<typeof assembleContext>>['messages'];
const assemble = async (): Promise<Assembled> => (await assembleContext('primary', 'm')).messages;
const said = (ms: Assembled): string => JSON.stringify(ms.map((m) => m.content));
const toolIds = (ms: Assembled): string[] => ms.flatMap((m) => (Array.isArray(m.content) ? m.content as unknown as Block[] : []))
  .filter((b) => b.type === 'tool_use' || b.type === 'tool_result').map((b) => `${b.type}:${String(b.id ?? b.tool_use_id)}`);
const paired = (ms: Assembled): void =>
  expect(repairToolPairing(structuredClone(ms) as unknown as PairedMessage[])).toEqual({ strippedToolUse: 0, strippedToolResult: 0, droppedMessages: 0 });

const histories: Record<string, () => void> = {
  unansweredWithText: () => {
    row('user', 'please check the file');
    row('assistant', [text('THE-AGENT-SAID-THIS before the call'), use('lost')]);
    row('user', 'any news?');
    row('assistant', 'here is my answer');
  },
  partialParallel: () => {
    row('user', 'read both');
    row('assistant', [use('a'), use('b')]);
    row('tool', [result('a')]);
    row('assistant', 'read a, b did not come back');
  },
  orphanResult: () => {
    row('user', 'hello');
    row('assistant', 'hi');
    row('tool', [result('ghost')]);
    row('user', 'still there?');
    row('assistant', 'yes');
  },
};

describe('a broken tool pair loses only its block', () => {
  beforeEach(() => { n = 0; });

  it('a. an assistant row with text and an unanswered call keeps its text', async () => {
    histories.unansweredWithText();
    const out = await assemble();
    expect(said(out)).toContain('THE-AGENT-SAID-THIS before the call');
    expect(said(out)).toContain('here is my answer');
    expect(toolIds(out)).toEqual([]);
  });

  it('b. a result separated from its call is moved next to it, and the rows between follow', async () => {
    row('user', 'read it');
    row('assistant', [use('x')]);
    row('user', 'BETWEEN-ROW typed while the tool ran');
    row('tool', [result('x')]);
    row('assistant', 'done reading');
    const out = await assemble();
    expect(toolIds(out)).toEqual(['tool_use:x', 'tool_result:x']);
    expect(said(out).indexOf('result of x')).toBeLessThan(said(out).indexOf('BETWEEN-ROW'));
    expect(said(out)).toContain('done reading');
    paired(out);
  });

  it('c. parallel calls with one result keep the answered pair and strip only the unanswered call', async () => {
    histories.partialParallel();
    const out = await assemble();
    expect(toolIds(out)).toEqual(['tool_use:a', 'tool_result:a']);
    expect(said(out)).toContain('read a, b did not come back');
  });

  it('d. a result with no call never reaches the model, and the rows around it stay', async () => {
    histories.orphanResult();
    const out = await assemble();
    expect(toolIds(out)).toEqual([]);
    for (const t of ['hello', 'hi', 'still there?', 'yes']) expect(said(out)).toContain(t);
  });

  it('e. a well-formed history keeps every block in stored order', async () => {
    row('user', 'read two files');
    row('assistant', [text('reading'), use('a'), use('b')]);
    row('tool', [result('a'), result('b')]);
    row('assistant', 'all read');
    const out = await assemble();
    expect(toolIds(out)).toEqual(['tool_use:a', 'tool_use:b', 'tool_result:a', 'tool_result:b']);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('f. a row of only unanswered calls leaves no message, not even its working note, and the roles still alternate', async () => {
    row('user', 'look it up');
    row('system', '[working-note] NOTE-BESIDE-THE-CALL');
    row('assistant', [use('gone')]);
    row('user', 'never mind');
    const out = await assemble();
    expect(out.map((m) => m.role)).toEqual(['user']);
    expect(said(out)).not.toContain('NOTE-BESIDE-THE-CALL');
  });

  it('g. the same history assembles to identical bytes twice, and the OpenAI request pairs every call', async () => {
    Object.values(histories).forEach((h) => h());
    const out = await assemble();
    expect(JSON.stringify(await assemble())).toBe(JSON.stringify(out));
    paired(out);
    const contract = contractForModel({ providerBaseUrl: 'https://api.example.com', apiModelId: 'gpt-example' });
    const msgs = out as Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>;
    const req = await buildOpenAIMessages('SYS', msgs, 'primary', contract) as unknown as Array<Record<string, unknown>>;
    const calls = req.flatMap((m) => ((m.tool_calls as Array<{ id: string }> | undefined) ?? []).map((c) => c.id));
    expect(req.filter((m) => m.role === 'tool').map((m) => String(m.tool_call_id))).toEqual(calls);
    expect(calls).toEqual(['a']);
  });
});
