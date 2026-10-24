// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18 fix round 4 — A POINTER NEVER CUTS A CHARACTER IN TWO, AND `msg:` READS ONLY WHAT THE VIEW COULD SHOW.
//
// Finding 4 (re-review 3, check b): the head/tail cut of `toolResultView` fell on a UTF-16 index, so a
// no-newline emoji row came out holding a lone surrogate in 12 of 16 probes — the same malformed string on
// every assembly, since the view is deterministic. The cut now lands on a character boundary (a whole
// grapheme where one is near: an emoji with its joiners, a letter with its combining marks), and so do the
// pages `tool_result_read` hands back.
// Finding 5 (check a): `msg:<id>` read any row of the agent, a row from before a session reset included.
// It now applies the scope the history tools apply: the session boundary and the conversation scope.
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
import { toolResultView } from '../tool-result-view.js';
import { findToolResult } from '../kept-results.js';
import { readResultPage } from '../../agent/tools/cat/result-read.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const COMBINING = /^\p{M}/u;
const pad = (k: number): string => 'abc'.slice(0, k);

/** The head and the tail a pointer shows, apart from its label. */
function headAndTail(view: string): { head: string; tail: string } {
  const [head, , tail] = view.split('\n\n');
  return { head, tail };
}

describe('finding 4: the head/tail cut never splits a character', () => {
  it('a no-newline emoji row, with 0–3 leading and trailing ASCII characters: no view holds a lone surrogate (the re-reviewer\'s 16 probes)', () => {
    for (let lead = 0; lead <= 3; lead++) {
      for (let trail = 0; trail <= 3; trail++) {
        const text = `${pad(lead)}${'🚢📦'.repeat(20_000)}${pad(trail)}`;
        const view = toolResultView(text, 'msg:probe');
        expect(view.length, 'it is a pointer').toBeLessThan(text.length);
        expect(LONE_SURROGATE.test(view), `lead ${lead}, trail ${trail}`).toBe(false);
      }
    }
  });

  it('an emoji joined by zero-width joiners stays whole at both cuts', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';   // a family: three emoji held by zero-width joiners
    for (let lead = 0; lead <= 7; lead++) {
      const text = `${'x'.repeat(lead)}${family.repeat(15_000)}`;
      const { head, tail } = headAndTail(toolResultView(text, 'msg:probe'));
      expect(head.slice(lead).length % family.length, `lead ${lead}: the head ends on a whole family`).toBe(0);
      expect(tail.length % family.length, `lead ${lead}: the tail starts on a whole family`).toBe(0);
    }
  });

  it('a letter keeps its combining marks: neither cut leaves a mark without its letter', () => {
    for (let lead = 0; lead <= 3; lead++) {
      const text = `${pad(lead)}${'éạ̈'.repeat(30_000)}`;
      const { head, tail } = headAndTail(toolResultView(text, 'msg:probe'));
      expect(COMBINING.test(tail), `lead ${lead}: the tail does not open on a bare mark`).toBe(false);
      expect(COMBINING.test(text.slice(head.length)), `lead ${lead}: the head did not leave its marks behind`).toBe(false);
    }
  });

  it('CJK text, the common plane and the supplementary one (𠀀 is a surrogate pair)', () => {
    for (let lead = 0; lead <= 3; lead++) {
      const view = toolResultView(`${pad(lead)}${'漢字𠀀かな'.repeat(20_000)}`, 'msg:probe');
      expect(LONE_SURROGATE.test(view), `lead ${lead}`).toBe(false);
      expect(view).toContain('漢字');
    }
  });

  it('the pages tool_result_read hands back are cut on a character boundary too', () => {
    const text = `a${'🚢'.repeat(40_000)}`;
    for (const offset of [0, 1, 2, 3]) {
      const page = readResultPage(text, 'msg:probe', { offset });
      expect(LONE_SURROGATE.test(page.slice(0, page.lastIndexOf('\n'))), `offset ${offset}`).toBe(false);
    }
    const longLine = readResultPage(text, 'msg:probe', {});
    expect(LONE_SURROGATE.test(longLine), 'one line longer than a page').toBe(false);
    const found = readResultPage(`${'🚢'.repeat(400)}NEEDLE${'📦'.repeat(400)}`, 'msg:probe', { search: 'needle' });
    expect(LONE_SURROGATE.test(found), 'a search\'s context around the match').toBe(false);
  });
});

const AGENT = 'agent-kept-row-scope';
const db = (): Database.Database => mockDb.current!;

describe('finding 5: msg: reads only a row the agent\'s view could show', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations();
    db().prepare(`INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
      VALUES ('prov', 'P', 'anthropic', 'agent-sdk', 1, datetime('now'), datetime('now'))`).run();
    db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
      VALUES ('m', 'prov', 'M', 'sonnet', '["text","tools"]', 32768, 4096, 1, datetime('now'), datetime('now'))`).run();
    db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
      VALUES (?, 'Dock Counter', 'm', 'working', '{}', datetime('now'), datetime('now'))`).run(AGENT);
    db().prepare(`INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
      VALUES ('agent-other', 'Other', 'm', 'working', '{}', datetime('now'), datetime('now'))`).run();
  });
  afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

  it('a row of this session and this conversation is read', () => {
    insertMessage({ id: 'row-now', agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: 'the manifest', conversationId: 'conv-dock' });
    expect(findToolResult(AGENT, 'msg:row-now')?.content).toBe('the manifest');
  });

  it('a row from before a session reset is refused', () => {
    insertMessage({ id: 'row-before-reset', agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: 'the old manifest', conversationId: 'conv-dock' });
    db().prepare("UPDATE messages SET created_at = created_at - 3600000 WHERE id = 'row-before-reset'").run();
    db().prepare("UPDATE agents SET session_started_at = datetime('now', '-1 minute') WHERE id = ?").run(AGENT);
    expect(findToolResult(AGENT, 'msg:row-before-reset')).toBeNull();
  });

  it('a person\'s row from another conversation is refused', () => {
    insertMessage({ id: 'row-other-conv', agentId: AGENT, role: 'user', lane: 'owner', senderId: 'someone', content: 'their manifest', conversationId: 'conv-other' });
    insertMessage({ id: 'row-this-conv', agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: 'my question', conversationId: 'conv-dock' });
    expect(findToolResult(AGENT, 'msg:row-other-conv')).toBeNull();
    expect(findToolResult(AGENT, 'msg:row-this-conv')?.content).toBe('my question');
  });

  it('another agent\'s row is refused (unchanged)', () => {
    insertMessage({ id: 'row-theirs', agentId: 'agent-other', role: 'user', lane: 'owner', senderId: 'owner', content: 'not yours' });
    expect(findToolResult(AGENT, 'msg:row-theirs')).toBeNull();
  });
});
