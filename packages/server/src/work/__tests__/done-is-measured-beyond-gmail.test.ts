// v3.5 field fix 3, audit #5 (W7, W15): "DONE IS MEASURED" BEYOND GMAIL.
//
// The owner (card, 2026-11-04): "This was something you just fixed in 3.5." The measure registry held
// two counters, both Gmail search, so a mailbox job in Outlook and a file job could not be measured at
// all. Two counters join it, in the registry's own shape (one entry each, loaded when a count is made):
//   * outlook_search / user_outlook_search: the messages a Graph search matches, every page;
//   * file_list with a glob: the files under a directory matching a pattern, counted by the engine by
//     walking the real directory (bounded by what is there, never by a number).
// Each is authorized like the read it names (`measure-door.ts` evaluates that tool's own gates).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const graph = vi.hoisted(() => ({ pages: [] as Array<{ ok: boolean; data?: unknown; error?: string }>, urls: [] as string[] }));
vi.mock('../../microsoft/client.js', () => ({
  msGraphRead: vi.fn(async (url: string) => { graph.urls.push(url); return graph.pages.shift() ?? { ok: false, error: 'no page' }; }),
}));
vi.mock('../../microsoft/accounts.js', () => ({
  resolveMicrosoftAccountForRead: (kind: string) => ({ account: { id: kind === 'user' ? 'user' : 'agent', email: null }, labelAccount: false }),
}));
vi.mock('../../microsoft/activity-log.js', () => ({ logMicrosoftActivity: () => {} }));

import { parseMeasure, countMeasure, describeMeasure, MEASURE_TOOLS } from '../measure.js';
import { WORK_MEASURE_PROP } from '../../agent/work-verb-schema.js';

let dir = '';
beforeEach(() => {
  graph.pages = []; graph.urls = [];
  dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'measure-files-'));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const touch = (rel: string): void => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), 'x'); };

describe('#5: the registry counts Outlook and file sets, in its own shape', () => {
  it('the new tools parse; each needs what it counts', () => {
    expect(parseMeasure({ tool: 'outlook_search', args: { query: 'is:unread' }, unit: 'messages' }).ok).toBe(true);
    expect(parseMeasure({ tool: 'user_outlook_search', args: { query: 'from:billing' } }).ok).toBe(true);
    expect(parseMeasure({ tool: 'file_list', args: { path: '/work/inbox', pattern: '*.pdf' }, unit: 'files' }).ok).toBe(true);
    const noPath = parseMeasure({ tool: 'file_list', args: { pattern: '*.pdf' } });
    expect(noPath.ok).toBe(false);
    const bad = parseMeasure({ tool: 'calendar_list', args: {} });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('supported: gmail_search, user_gmail_search, outlook_search, user_outlook_search, file_list');
  });

  it('file_list: counts the files under the directory that match the pattern, and shrinks as files leave', async () => {
    touch('a.pdf'); touch('b.pdf'); touch('c.txt'); touch('sub/d.pdf'); touch('sub/deeper/e.pdf');
    const top = parseMeasure({ tool: 'file_list', args: { path: dir, pattern: '*.pdf' } });
    const all = parseMeasure({ tool: 'file_list', args: { path: dir, pattern: '**/*.pdf' } });
    if (!top.ok || !all.ok) throw new Error('parse');
    expect(await countMeasure(top.measure, 'a', 'A')).toEqual({ ok: true, count: 2 });
    expect(await countMeasure(all.measure, 'a', 'A')).toEqual({ ok: true, count: 4 });
    fs.rmSync(path.join(dir, 'a.pdf'));
    expect(await countMeasure(top.measure, 'a', 'A')).toEqual({ ok: true, count: 1 });
    expect(describeMeasure(top.measure)).toBe(`file_list "*.pdf" under ${dir}`);
  });

  it('file_list: a directory that is not there is a reading that could not be made, never 0', async () => {
    const m = parseMeasure({ tool: 'file_list', args: { path: path.join(dir, 'gone'), pattern: '*' } });
    if (!m.ok) throw new Error('parse');
    const r = await countMeasure(m.measure, 'a', 'A');
    expect(r.ok).toBe(false);
  });

  it('outlook_search: every page of the Graph search is counted (ids only); a failed page is no reading', async () => {
    graph.pages = [
      { ok: true, data: { value: [{ id: '1' }, { id: '2' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next1' } },
      { ok: true, data: { value: [{ id: '3' }] } },
    ];
    const m = parseMeasure({ tool: 'user_outlook_search', args: { query: 'from:billing' } });
    if (!m.ok) throw new Error('parse');
    expect(await countMeasure(m.measure, 'a', 'A')).toEqual({ ok: true, count: 3 });
    expect(graph.urls[0]).toMatch(/^me\/messages\?\$search=/);
    expect(graph.urls[0]).toContain('$select=id');
    graph.pages = [{ ok: false, error: 'HTTP 503' }];
    expect((await countMeasure(m.measure, 'a', 'A')).ok).toBe(false);
  });

  it('the tool schema offers exactly the registry\'s tools (one list, no drift)', () => {
    const tools = (WORK_MEASURE_PROP as { properties: { tool: { enum: string[] } } }).properties.tool.enum;
    expect(tools).toEqual(MEASURE_TOOLS);
  });
});
