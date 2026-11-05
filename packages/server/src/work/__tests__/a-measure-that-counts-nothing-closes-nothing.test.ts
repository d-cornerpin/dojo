// v3.5 field fix 3, re-review 2 S2 + S10: A MEASURE THAT COUNTS NOTHING CLOSES NOTHING, AND THE FILE WALK
// IS BOUNDED, GATED AND HONEST.
//
// S2: the owner says "file the PDFs in my Inbox folder"; the agent sets `file_list` "*.pdf" but the scans
// are named `Scan 12.PDF`; the measure reads 0 at set time and the task closes on a count that never
// counted anything. Now: a measure whose first reading is 0 is refused when it is set, with the fact;
// the glob follows the measured folder's own case sensitivity (measured on that volume, not assumed);
// and a 0 backs a close only when the count came DOWN to it (see the K35 suite).
// S10: the walk stops on the turn's own abort, names an unreadable subfolder instead of voiding the
// whole count, never follows a symlink, and the end-of-turn count passes the same gates as set and close.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const gm = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../google/measure-count.js', () => ({ countGmailSearch: async () => ({ ok: true, count: gm.count }) }));
vi.mock('../../agent/tools/gates.js', async (orig) => ({ ...(await orig<typeof import('../../agent/tools/gates.js')>()), gatesForCall: () => [] }));
vi.mock('../../db/connection.js', () => ({ getDb: () => ({ prepare: () => ({ get: () => ({ name: 'Agent' }) }) }), getDbPath: () => ':memory:', closeDb: () => {} }));

import { countFileSet } from '../../tools/file-set-count.js';
import { readMeasureArg } from '../../agent/tools/cat/measure-door.js';
import { activeAbortControllers, abortInFlight } from '../../agent/shared-state.js';
import { engineFileContaining } from '../../agent/v2/__tests__/engine-sources.js';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'measure-zero-')); gm.count = 0; });
afterEach(() => {
  for (const d of [path.join(dir, 'locked')]) { try { fs.chmodSync(d, 0o755); } catch { /* not made */ } }
  fs.rmSync(dir, { recursive: true, force: true });
  activeAbortControllers.delete('walk-agent');
});
const touch = (rel: string): void => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), 'x'); };
/** The real answer for THIS test folder's volume, measured the way a person would. */
const volumeFolds = (): boolean => { const f = path.join(dir, 'CaseProbe'); fs.writeFileSync(f, 'x'); const folds = fs.existsSync(path.join(dir, 'caseprobe')); fs.rmSync(f); return folds; };

describe('S2: the glob follows the folder\'s own case sensitivity', () => {
  it('*.pdf against Scan.PDF: counted exactly when this volume ignores case', async () => {
    const folds = volumeFolds();
    touch('Scan 12.PDF'); touch('scan-13.pdf');
    expect(await countFileSet({ path: dir, pattern: '*.pdf' })).toMatchObject({ ok: true, count: folds ? 2 : 1 });
  });
});

describe('S2: a measure whose first reading is 0 is refused when it is set', () => {
  const ZERO = 'this measure reads 0 now, so it cannot show progress; check the folder, pattern or query';
  it('a wrong folder (nothing there to do): refused with the fact', async () => {
    const r = await readMeasureArg('a1', { tool: 'file_list', args: { path: dir, pattern: '*.pdf' } });
    expect(r.error).toBe(`Error: ${ZERO}.`);
  });
  it('a Gmail query that matches nothing: refused with the fact', async () => {
    gm.count = 0;
    const r = await readMeasureArg('a1', { tool: 'gmail_search', args: { query: 'label:Nope' } });
    expect(r.error).toBe(`Error: ${ZERO}.`);
  });
  it('CONTROL: a measure with items to do is set', async () => {
    gm.count = 7;
    const r = await readMeasureArg('a1', { tool: 'gmail_search', args: { query: 'in:inbox' } });
    expect(r.error).toBeUndefined();
    expect(r.reading?.count).toEqual({ ok: true, count: 7 });
  });
});

describe('S10: the walk is bounded, honest and safe', () => {
  it('an unreadable subfolder is NAMED, and the rest is still counted', async () => {
    if (process.getuid?.() === 0) return;   // root reads everything; nothing to prove
    touch('a.pdf'); touch('locked/b.pdf');
    fs.chmodSync(path.join(dir, 'locked'), 0o000);
    const r = await countFileSet({ path: dir, pattern: '**/*.pdf' });
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(r.ok && r.unreadable).toEqual([path.join(dir, 'locked')]);
  });

  it('a symlinked folder is never followed (no loop, no double count)', async () => {
    touch('real/a.pdf');
    fs.symlinkSync(dir, path.join(dir, 'real', 'loop'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'));
    expect(await countFileSet({ path: dir, pattern: '**/*.pdf' })).toMatchObject({ ok: true, count: 1 });
  });

  it('the turn\'s own abort stops the walk: a stop is no reading, never a partial count', async () => {
    for (let i = 0; i < 200; i += 1) touch(`d${i}/x.pdf`);
    const walking = countFileSet({ path: dir, pattern: '**/*.pdf' }, 'walk-agent');
    for (let i = 0; i < 200 && !activeAbortControllers.has('walk-agent'); i += 1) await new Promise((r) => setTimeout(r, 1));
    expect(activeAbortControllers.has('walk-agent')).toBe(true);   // the walk runs under the agent's stop
    abortInFlight('walk-agent', 'user-stop', { scope: 'all' });
    const r = await walking;
    expect(r.ok).toBe(false);
  });

  it('the end-of-turn count passes the same gates as set and close (the measure door)', () => {
    // Located through the shared engine-source derivation (the guard-corpus census), never by path.
    const turnEnd = engineFileContaining('export async function readJobAtPassEnd(');
    expect(turnEnd, 'the turn-end reading is in the engine').not.toBeNull();
    expect(turnEnd!.text).toMatch(/gatedMeasureCount\(/);
    expect(turnEnd!.text).not.toMatch(/\bcountMeasure\(facts\.measure/);
  });
});
