// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18b — A ROW WHOSE BULK IS NOT TEXT IS NEVER SHOWN WHOLE OVER THE ROOM (`kept-row-view.ts`).
//
// t257's final re-review: a structured row whose bulk is a base64 image or document, or a huge `tool_use`
// input, was shown whole. Now:
//   · a long call input keeps the call's id and name; each long argument is its head + tail +
//     `msg:<id>#<n>.<argument>`, and `msg:<id>#<n>` reads the whole input;
//   · an image or document block whose own cost (the boundary's: an image by its pixels) exceeds the room is
//     its note — kind, name, type, size, and that it is not shown;
//   · a row still over the room after that and after the text collapse carries no non-text bulk whole;
//   · the turn's injected attachments obey the same room (`attachmentsWithinRoom`).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => undefined, storeEmbedding: async () => undefined, refreshEmbedding: () => undefined,
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { findToolResult } from '../kept-results.js';
import * as view from '../kept-row-view.js';
import { messageTokens } from '../lanes.js';

const AGENT = 'agent-d18b-unit';
const db = (): Database.Database => mockDb.current!;
const ROOM = 4_000;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
    VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m', 'prov', 'M', 'sonnet', '["text","tools","vision"]', 32768, 4096, 1, datetime('now'), datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES (?, 'The Agent', 'm', 'working', '{}', datetime('now'), datetime('now'))`).run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

type Block = { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string; source?: { data?: string } };
function store(id: string, role: 'user' | 'assistant', blocks: unknown[]): { id: string; agentId: string; role: string; content: string; tokenCount: null } {
  const content = JSON.stringify(blocks);
  insertMessage({ id, agentId: AGENT, role, lane: 'owner', senderId: role === 'user' ? 'owner' : undefined, content });
  return { id, agentId: AGENT, role, content, tokenCount: null };
}
const shownBlocks = (m: { content: string }): Block[] => JSON.parse(m.content) as Block[];
const cost = (blocks: unknown[]): number => messageTokens({ role: 'user', content: blocks as never });

/** A PNG of the given size: a real header (what the boundary prices by), padded with bytes it does not charge for. */
function png(width: number, height: number, padBytes: number): string {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'ascii'); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(padBytes, 7)]).toString('base64');
}

describe('a long tool_use input', () => {
  const body = `${'crate 0412, north dock, sealed, 40 kg, inspected\n'.repeat(2_000)}END OF FILE`;
  it('keeps the call\'s id and name; a short argument as it is, the long one as head + tail + its own pointer', () => {
    const row = store('row-write', 'assistant', [{ type: 'text', text: 'Writing it.' }, { type: 'tool_use', id: 'call-1', name: 'file_write', input: { path: '/tmp/m.txt', content: body } }]);
    const blocks = shownBlocks(view.overRoomRowView(row as never, ROOM));
    const call = blocks.find((b) => b.type === 'tool_use')!;
    expect(call.id).toBe('call-1');
    expect(call.name).toBe('file_write');
    expect(call.input!.path).toBe('/tmp/m.txt');
    const shown = String(call.input!.content);
    expect(shown.length, 'never the whole').toBeLessThan(body.length / 4);
    expect(shown).toContain('crate 0412, north dock');
    expect(shown).toContain('END OF FILE');
    expect(shown).toContain('msg:row-write#1.content');
    expect(cost(blocks), 'the view fits the room').toBeLessThanOrEqual(ROOM);
  });

  it('`msg:<id>#<n>.<argument>` reads the argument whole, and `msg:<id>#<n>` reads the whole input', () => {
    const row = store('row-write-2', 'assistant', [{ type: 'tool_use', id: 'call-2', name: 'file_write', input: { path: '/tmp/m.txt', content: body } }]);
    view.overRoomRowView(row as never, ROOM);
    expect(findToolResult(AGENT, 'msg:row-write-2#0.content')?.content).toBe(body);
    const all = findToolResult(AGENT, 'msg:row-write-2#0');
    expect(all?.content.startsWith('path: /tmp/m.txt\ncontent: crate 0412')).toBe(true);
    expect(all?.toolName).toBe('file_write');
    expect(findToolResult(AGENT, 'msg:row-write-2#0.no_such_argument')).toBeNull();
  });

  it('a row of many calls, none long alone, still over the room: every call keeps id and name, no input rides whole', () => {
    const calls = Array.from({ length: 60 }, (_, i) => ({ type: 'tool_use', id: `call-${i}`, name: 'vault_put', input: { key: `crate-${i}`, value: 'north dock ledger line. '.repeat(250) } }));
    const row = store('row-many-calls', 'assistant', calls);
    expect(cost(calls), 'precondition: over the room').toBeGreaterThan(ROOM);
    const blocks = shownBlocks(view.overRoomRowView(row as never, ROOM));
    expect(blocks.map((b) => b.id)).toEqual(calls.map((c) => c.id));
    expect(blocks.every((b) => b.name === 'vault_put')).toBe(true);
    expect(blocks.every((b) => !JSON.stringify(b.input).includes('ledger line. north dock')), 'no input rides whole').toBe(true);
    expect(cost(blocks), 'a fraction of the whole').toBeLessThan(cost(calls) / 10);
    expect(JSON.stringify(blocks)).toContain('msg:row-many-calls#59');
  });
});

describe('a row of text blocks and calls, over the room after the text collapse', () => {
  it('each call\'s label names its OWN block, and reads that call\'s input', () => {
    const texts = Array.from({ length: 400 }, (_, i) => ({ type: 'text', text: `crate ${i}, north dock, sealed, 40 kg${'.'.repeat(40)}` }));
    const calls = Array.from({ length: 30 }, (_, i) => ({ type: 'tool_use', id: `call-${i}`, name: 'vault_put', input: { key: `crate-${i}`, value: `ledger ${i}: ${'north dock line. '.repeat(300)}` } }));
    const row = store('row-mixed', 'assistant', [...texts, ...calls]);
    const blocks = shownBlocks(view.overRoomRowView(row as never, ROOM));
    expect(blocks.filter((b) => b.type === 'text'), 'the text blocks collapsed into one pointer').toHaveLength(1);
    const last = blocks.find((b) => b.id === 'call-29')!;
    const handle = /msg:row-mixed#\d+/.exec(JSON.stringify(last.input))![0];
    expect(handle, 'block 429 is call-29').toBe('msg:row-mixed#429');
    expect(findToolResult(AGENT, handle)?.content).toContain('value: ledger 29:');
  });
});

describe('an image or document block', () => {
  it('a base64 PDF over the room is its note: name, type, size, not shown; the text beside it stays', () => {
    const data = Buffer.from(`%PDF-1.4\n${'0 0 obj << /Crate 0412 >> endobj\n'.repeat(3_000)}`).toString('base64');
    const row = store('row-scan', 'user', [{ type: 'text', text: 'Here is the scan.' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: 'scan.pdf' }]);
    const shown = view.overRoomRowView(row as never, ROOM);
    expect(shown.content, 'never the bytes').not.toContain(data.slice(0, 64));
    const note = shownBlocks(shown).find((b) => b.type === 'text' && b.text!.includes('scan.pdf'))!.text!;
    expect(note).toContain('PDF');
    expect(note).toContain('application/pdf');
    expect(note).toContain(`${Buffer.byteLength(data, 'base64').toLocaleString('en-US')} bytes`);
    expect(note).toContain('NOT shown');
    expect(shownBlocks(shown)[0].text).toBe('Here is the scan.');
  });

  it('an image is priced by its pixels, never its base64 length: a small picture in a large file is kept; a picture the room cannot hold is its note', () => {
    const small = store('row-small-pic', 'user', [{ type: 'text', text: 'The dock.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(64, 64, 120_000) } }]);
    expect(shownBlocks(view.overRoomRowView(small as never, ROOM)).some((b) => b.type === 'image'), 'kept: it costs its pixels').toBe(true);
    const large = store('row-large-pic', 'user', [{ type: 'text', text: 'The whole yard.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(4096, 4096, 30_000) } }]);
    const blocks = shownBlocks(view.overRoomRowView(large as never, ROOM));
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
    expect(blocks.some((b) => b.type === 'text' && /image \(image\/png, [\d,]+ bytes[^)]*\) is larger than/.test(b.text!))).toBe(true);
  });

  it('the turn\'s injected attachments: one over the room is its note, one within it rides, and no room known leaves them alone', () => {
    const big = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x'.repeat(10_000) }, title: 'big.pdf' };
    const pic = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(64, 64, 10) } };
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'two files' }, big, pic] as unknown[] }];
    view.attachmentsWithinRoom(messages, undefined);
    expect((messages[0].content as Block[]).map((b) => b.type)).toEqual(['text', 'document', 'image']);
    view.attachmentsWithinRoom(messages, ROOM);
    const after = messages[0].content as Block[];
    expect(after.map((b) => b.type)).toEqual(['text', 'text', 'image']);
    expect(after[1].text).toContain('"big.pdf"');
    expect(after[1].text).toContain('pdf_read');
  });
});
