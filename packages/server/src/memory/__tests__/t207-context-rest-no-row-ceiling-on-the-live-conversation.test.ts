// ════════════════════════════════════════════════════════════════════════════════════════
// t207 (D6, ctx 10) — THE LIVE CONVERSATION HAS NO ROW CEILING.
//
// The horizon carried a row count (8 x the window's row floor: 640 rows at 200K) standing in for "compaction
// has not run for a long time". Above it the front skipped whole half-ceiling steps and the view lost rows
// that fit in a fraction of the window. The real signals are tokens (the view is full) and rows the trim has
// already taken out of view. The ceiling is gone; the one thing it protected, the cost of reading an unbounded
// number of rows, is replaced by a read that stops once the newest rows cover the budget.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { assembleContext } from '../assembler.js';
import { contextWindowPolicy } from '../budget.js';
import * as horizonModule from '../tail-horizon.js';

const AGENT = 'agent-t207-horizon';
const SRC = path.resolve(__dirname, '..', '..');

let image: Buffer | null = null;
function freshDb(): Database.Database {
  if (!image) {
    const s = new Database(':memory:');
    mockDb.current = s;
    runMigrations();
    image = s.serialize();
    s.close();
  }
  const db = new Database(image);
  db.pragma('foreign_keys = ON');
  return db;
}
beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'A', 'm', 'idle', '{}', 'sensei')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const policy = (): ReturnType<typeof contextWindowPolicy> =>
  contextWindowPolicy(200_000, { toolPayloadTokens: 1000, maxOutputTokens: 4096 });

function seedRows(n: number, body: (i: number) => string): void {
  const insert = mockDb.current!.transaction(() => {
    for (let i = 0; i < n; i++) {
      insertMessage({
        agentId: AGENT, role: i % 2 === 0 ? 'user' : 'assistant', lane: 'owner', senderId: i % 2 === 0 ? 'owner' : null,
        content: body(i), turnNumber: 1 + Math.floor(i / 2),
      });
    }
  });
  insert();
}

describe('t207 D6 — 700 tiny rows are all in view on a 200K window', () => {
  it('the horizon keeps every row since the boundary: no skip, no ceiling', () => {
    seedRows(700, (i) => `[row ${i}] ok`);
    const h = horizonModule.freshTailHorizon(AGENT, policy());
    expect(h.rowsSinceBoundary).toBe(700);
    expect(h.requestRows).toBe(700);
    expect(h.keepFromSeq).toBeGreaterThan(0);
    expect((h as unknown as { skippedRows?: number }).skippedRows ?? 0).toBe(0);
  });

  it('the assembled view holds the first and the last of them', async () => {
    seedRows(700, (i) => `[row ${i}] ok`);
    const ctx = await assembleContext(AGENT, 'm');
    const text = JSON.stringify(ctx.messages);
    expect(text).toContain('[row 0]');
    expect(text).toContain('[row 699]');
    expect(ctx.freshTailDropped ?? 0).toBe(0);
  });
});

describe('t207 D6 — the read stops once the newest rows cover the budget', () => {
  it('3,000 large rows: only enough newest rows to cover twice the budget are read, and the rest are counted as unread', () => {
    seedRows(3000, (i) => `[row ${i}] ${'word '.repeat(400)}`);   // ~500 tokens a row
    const cover = 40_000;
    const h = horizonModule.freshTailHorizon(AGENT, policy(), cover);
    const unread = (h as unknown as { unreadRows?: number }).unreadRows ?? 0;
    expect(unread, 'rows left unread').toBeGreaterThan(2000);
    expect(h.requestRows + unread).toBe(3000);
    expect(h.requestRows * 400, 'the rows read cover the budget').toBeGreaterThanOrEqual(cover);
    expect(h.requestRows, 'and not much more than it').toBeLessThan(400);
    expect(h.keepFromSeq).toBeGreaterThan(unread);   // the read begins after the unread rows
  });

  it('with no budget to cover (or a tail that fits), everything since the boundary is read', () => {
    seedRows(300, (i) => `[row ${i}] ok`);
    const h = horizonModule.freshTailHorizon(AGENT, policy(), 1_000_000);
    expect(h.requestRows).toBe(300);
    expect((h as unknown as { unreadRows?: number }).unreadRows ?? 0).toBe(0);
  });
});

describe('t207 D6 — the ceiling and its causes are gone from shipped code', () => {
  it('no ceiling export, no step, no lead, no ceiling cause', () => {
    for (const name of ['TAIL_HORIZON_CEILING_MULTIPLE', 'tailCeilingStepRows', 'ceilingSkipRows', 'ceilingLeadRows']) {
      expect((horizonModule as Record<string, unknown>)[name], name).toBeUndefined();
    }
    const text = fs.readFileSync(path.join(SRC, 'memory/tail-horizon.ts'), 'utf8');
    expect(text).not.toMatch(/'ceiling'|ceilingBound|TAIL_HORIZON_CEILING|ceilingSkipRows|the row ceiling trimmed/);
  });
});
