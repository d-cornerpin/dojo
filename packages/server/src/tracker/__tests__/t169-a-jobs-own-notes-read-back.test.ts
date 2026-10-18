// ════════════════════════════════════════════════════════════════════════════════════════
// t169 — A LONG JOB'S OWN NOTES CAN BE READ BACK (run 9, S1 attempt 2).
//
// `work_note` writes the task's audit trail (an `observation` entry). `work_update get` rendered the
// separate notes FIELD, which `work_note` never fills, so an agent that kept its findings in notes
// and then lost them from view had no door that returned them: it re-read 154 pages to rebuild what
// it had already written down, and the PM ruled it circling.
//
// Clauses (each drives the real tracker handlers the model's tool calls reach):
//   1  every note, in order, comes back from `work_update get` — the assignee's and the PM's, each
//      with its time;
//   2  more notes than one view hold come in pages that end in a "continue" footer that is itself in
//      view, and following the footer reads every note exactly once;
//   3  the attempt ledger (which shows only the newest few notes) says there are more and names the
//      call that reads them;
//   4  `work_note`'s description says where the notes are read back, and the call it names takes the
//      offset the footer teaches.
//
// RED-FIRST at 104a7dd6: committed as `it.fails`, flipped with the fix.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t169-notes');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t169-notes');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t169-notes', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({
  broadcast: () => { /* not exercised */ },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
    getAgentUptime: () => 0,
  }),
  stopAgent: vi.fn(),
}));

import { runMigrations } from '../../db/migrations.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { admitToolResult } from '../../agent/tools/index.js';
import { toolDefinitions } from '../../agent/tools/definitions.js';
import { buildWorkBoardLane } from '../../memory/work-board-lane.js';
import { TOOL_RESULT_VIEW_CHARS } from '../../memory/tool-result-view.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const db = (): Database.Database => mockDb.current!;
const TASK = 'task-notes-1';

type Handler = (ctx: { agentId: string; args: Record<string, unknown> }) => Promise<{ content: string; isError: boolean }>;
const call = async (op: string, agentId: string, args: Record<string, unknown>): Promise<string> => {
  const h = (trackerHandlers as unknown as Record<string, Handler>)[op];
  const out = await h({ agentId, args });
  // The same cap the engine applies to every result of this tool before the model sees it.
  return out.isError ? out.content : admitToolResult(op.split(':')[0], 'call-t169', out.content).content;
};
const note = (agentId: string, text: string): Promise<string> => call('work_note', agentId, { task_id: TASK, notes: text });
const get = (agentId: string, extra: Record<string, unknown> = {}): Promise<string> =>
  call('work_update:get', agentId, { action: 'get', id: TASK, ...extra });

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  d.prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES
    ('helper', 'Helper', 'idle', 'm-a', 'apprentice'), ('pm', 'PM', 'idle', 'm-a', 'sensei')`).run();
  seedTrackerTask(d, {
    id: TASK, agentId: 'helper', status: 'in_progress', title: 'the ledger audit',
    opened_at: Date.now() - 60_000, updated_at: Date.now() - 60_000, origin_conv_key: 'c-1', priority: 'normal',
  } as never);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** Every `NOTE-nn` marker in a page, in the order it appears. */
const markers = (s: string): string[] => [...s.matchAll(/NOTE-(\d+)/g)].map((m) => m[1]);
/** `offset=N` of the page's continue line, or null at the end. */
const nextOffset = (s: string): number | null => {
  const m = s.match(/continue[^\n]*offset\s*[=:]?\s*(\d+)/i) ?? s.match(/offset\s*=\s*(\d+)/i);
  return m ? Number(m[1]) : null;
};

describe('1 — the notes the agent wrote come back, in order, with their times', () => {
  it('work_note x N then work_update get: every note is present, oldest first, each with a time and its writer', async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `NOTE-${String(i).padStart(2, '0')} wrong lines on pages ${i * 8 + 1}-${i * 8 + 8}: 3, 17, 22`);
    for (const t of texts) expect(await note('helper', t)).toContain('[OK]');
    expect(await note('pm', 'NOTE-06 the PM saw the first six notes and they read as steady progress')).toContain('[OK]');
    const out = await get('helper');
    expect(markers(out)).toEqual(['00', '01', '02', '03', '04', '05', '06']);
    for (const t of texts) expect(out).toContain(t);
    // each line carries a recorded time (the trail's own YYYY-MM-DD HH:MM:SS) and who wrote it
    const noteLines = out.split('\n').filter((l) => /NOTE-\d+/.test(l));
    expect(noteLines).toHaveLength(7);
    for (const l of noteLines) expect(l).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(noteLines[6]).toMatch(/PM/i);
    expect(noteLines[0]).not.toMatch(/PM/i);
  });

  it('the notes FIELD, when it has content, is still shown beside them', async () => {
    db().prepare("UPDATE work SET notes = 'FIELD-TEXT carried from an older version' WHERE id = ?").run(TASK);
    await note('helper', 'NOTE-00 a note in the trail');
    const out = await get('helper');
    expect(out).toContain('FIELD-TEXT carried from an older version');
    expect(out).toContain('NOTE-00 a note in the trail');
  });

  it('a task with no notes says nothing new (no empty notes heading)', async () => {
    const out = await get('helper');
    expect(out).not.toMatch(/NOTE-/);
    expect(out).not.toMatch(/notes written/i);
  });
});

describe('2 — more notes than one view holds come in pages that can be followed to the end', () => {
  it('pages end in a continue footer that survives the engine cap, and following it reads every note once, in order', async () => {
    const N = 40;
    const filler = 'x'.repeat(5000);
    for (let i = 0; i < N; i++) await note('helper', `NOTE-${String(i).padStart(2, '0')} ${filler}`);
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null && pages < 20) {
      const page: string = await get('helper', offset === 0 ? {} : { offset });
      expect(page.length).toBeLessThanOrEqual(TOOL_RESULT_VIEW_CHARS);
      seen.push(...markers(page));
      offset = nextOffset(page);
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => String(i).padStart(2, '0')));
    expect(offset).toBeNull();
  });

  it('a page past the end says so instead of answering with an empty list', async () => {
    await note('helper', 'NOTE-00 only note');
    const out = await get('helper', { offset: 5 });
    expect(out).toMatch(/1 note/);
    expect(out).not.toMatch(/NOTE-00/);
  });
});

describe('3 — the attempt ledger says there are more notes and how to read them', () => {
  it('with more notes than the ledger shows, its section names work_update get on that task', async () => {
    // t207: the ledger shows as many notes as the room holds (no fixed count), so the notes are long enough
    // that nine of them do not fit the room the array leaves a view this small.
    const filler = 'y'.repeat(900);
    for (let i = 0; i < 9; i++) await note('helper', `NOTE-${String(i).padStart(2, '0')} found something on page ${i} ${filler}`);
    const lane = await buildWorkBoardLane('helper', { availableTokens: 3_600, emitted: [], blocks: [], liveRows: [] });
    const ledger = lane.attemptLedger ?? '';
    expect(ledger).toContain('NOTE-08');
    expect(ledger).not.toContain('NOTE-00');
    expect(ledger).toMatch(/work_update/);
    expect(ledger).toContain(`id="${TASK}"`);
    expect(ledger).toMatch(/\b\d+ more notes\b/);
    expect(ledger).toMatch(/\d+ earlier entries not shown/);
  });

  it('with every note already shown, the ledger adds no pointer', async () => {
    for (let i = 0; i < 3; i++) await note('helper', `NOTE-${String(i).padStart(2, '0')} found something on page ${i}`);
    const lane = await buildWorkBoardLane('helper');
    expect(lane.attemptLedger ?? '').toContain('NOTE-00');
    expect(lane.attemptLedger ?? '').not.toMatch(/work_update/);
  });
});

describe('4 — the tool descriptions tell the truth about where notes are read back', () => {
  const def = (name: string): { description: string; input_schema: { properties: Record<string, { description?: string }> } } =>
    toolDefinitions.find((t) => t.name === name) as never;

  it("work_note names the door that reads the notes back, and no longer promises a field it does not fill", () => {
    const d = def('work_note').description;
    expect(d).toMatch(/work_update/);
    expect(d).toMatch(/get/);
    expect(d).not.toMatch(/Preserves all prior notes/);
  });

  it('work_update declares the offset its own continue footer teaches', () => {
    expect(def('work_update').input_schema.properties.offset).toBeDefined();
  });
});
