// ════════════════════════════════════════════════════════════════════════════════
// t90 D3, second half — THE MISMATCH IS VISIBLE BEFORE THE RUN. (live-test report #4)
//
// *"A sub-agent was spawned for a small local task whose entire purpose was to write a single short
// line into a file … Its instructions told it to use file tools … The task was therefore unrunnable
// end to end: the agent held the assignment, held the instruction to write the file, and held no
// tool in any group that could touch the filesystem."*
//
// ── WHAT IS AND IS NOT BEING CHECKED ──
// The report's fix idea opens *"if the task description implies filesystem or shell work"*, and
// inferring intent from prose is a banned class here (the round-11 NOT-DOING list; `join-drive.ts`
// states the rule as "the engine may count structure and may not classify reply prose"). So the
// check matches TOOL NAMES — a closed vocabulary minted in one file — against the words the
// spawner actually wrote. §1 pins that boundary, including the substring trap t87 paid for.
//
// §1 the vocabulary match: names only, word-boundaried, no intent anywhere
// §2 the verdict: the executor's OWN predicate decides, so a warning cannot be false
// §3 the warning's words, and ⚠ §4 the WIRE at both spawn texts
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
/**
 * ⚠ FIX ROUND 3 — THE LOGGER IS STUBBED, AND IT IS A HANDLE FIX, NOT TIDINESS.
 *
 * This file drives `runMigrations()` against the real migration set, which logs heavily, and the
 * real logger is a BUFFERED ASYNC WRITER: `writeEntry` queues `fs.appendFile` and arms a 500 ms
 * flush timer (`logger.ts:61-89`). MEASURED with `process.getActiveResourcesInfo()` in an
 * `afterAll`: this file finished holding **81 in-flight `FSReqCallback`** handles — 81 filesystem
 * writes still in the worker's event loop after the last clause passed. The merge gate's full-suite
 * run then exited 1 on `[vitest-worker]: Timeout calling "onTaskUpdate"`: a worker saturated with
 * queued filesystem work does not service its RPC to the main process in time. Main's control runs
 * were clean because this file is NEW in t90 — the package was adding the handles.
 *
 * Stubbing `createLogger` takes the count to ZERO (81 → 0, re-measured), which is the root cause
 * removed rather than a timeout raised. Nothing here asserts on a log line, so nothing is lost; a
 * clause that ever does should capture the logger the way
 * `tracker/__tests__/the-pm-waits-for-the-model-it-assigned.test.ts` does, not un-stub it.
 */
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogLevel: () => { /* no-op */ },
  setLogBroadcast: () => { /* no-op */ },
  readLogEntries: () => [],
}));
/**
 * ⚠ FIX ROUND 3: the home this mock hands out is the WORKER'S OWN throwaway home, not one fixed
 * path shared by every worker and every run. It used to be `<os tmpdir>/dojo-t90-assignment-capability` —
 * one directory, which is the problem `vitest.setup.ts` had already solved: `DOJO_HOME` gives
 * each worker a private home precisely so concurrent workers cannot write the same tree
 * (`src/home.ts`'s header records the run that destroyed the owner's log history doing exactly
 * that). The mock survives only because it must never resolve the REAL home either, so it reads
 * the sandbox the setup file set and fails loudly if that is missing.
 */
vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const home = process.env.DOJO_HOME;
  if (!home) throw new Error('DOJO_HOME is unset: vitest.setup.ts gives each worker its own home');
  return {
    homeDir: (): string => home,
    dojoDir: (...segs: string[]): string => p.join(home, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { forgetAccessGrants } from '../read.js';
import { deriveLegacyGrants } from '../derive.js';
import {
  namedTools, assignmentCapabilityMismatch, mismatchWarning, MISMATCH_NAMED_MAX,
} from '../../tools/assignment-capability.js';
import type { AccessGrants } from '@dojo/shared';

const db = (): Database.Database => mockDb.current!;

function agent(id: string, mutate?: (g: AccessGrants) => void): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, session_started_at)
     VALUES (?, ?, 'idle', 'ronin', '1970-01-01')`,
  ).run(id, id);
  forgetAccessGrants();
  if (!mutate) return;
  const g = deriveLegacyGrants(id);
  mutate(g);
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
}

/** FIX ROUND 3: `beforeEach` replaces this with a fresh `Database(':memory:')`, and nothing used
 *  to close the one it replaced — 11 clauses here, so 10 abandoned sqlite handles left for
 *  the GC to notice. Closed where it is opened, so the count cannot grow with the clause list. */
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  forgetAccessGrants();
});

// ════════════════════════════════════════════════════════════════════════════════
// §1 — NAMES, NOT INTENT
// ════════════════════════════════════════════════════════════════════════════════

describe('§1 the check counts tool names and never reads intent', () => {
  it('finds the names an instruction actually writes', () => {
    const found = namedTools('Write the line with file_write, and check it with file_read after.');
    expect(found).toContain('file_write');
    expect(found).toContain('file_read');
  });

  /**
   * ⚠ THE PROSE THE REPORT'S OWN FIX IDEA WOULD HAVE MATCHED, AND THIS MUST NOT.
   *
   * "implies filesystem work" is the banned class: it is wrong in both directions and it is not
   * this engine's job. A task that needs a file tool but names none is invisible here, ON PURPOSE
   * — the executor's refusal (t90's first half) is what catches that one, and it now names what
   * the agent holds.
   */
  it('reads no intent: filesystem prose naming no tool matches nothing', () => {
    expect(namedTools('Write a single short line into a file in the home directory')).toEqual([]);
    expect(namedTools('save the results to disk and then tidy up the folder')).toEqual([]);
    expect(namedTools('')).toEqual([]);
    expect(namedTools(null)).toEqual([]);
  });

  it('⚠ word boundaries, which is the trap t87 paid for in the provider classifier', () => {
    // A substring match reads `file_read` inside `profile_reader`. The lookarounds refuse it.
    expect(namedTools('the profile_reader module')).not.toContain('file_read');
    expect(namedTools('xfile_write')).not.toContain('file_write');
    expect(namedTools('file_writes')).not.toContain('file_write');
    // …while the shapes an instruction really uses all match.
    for (const text of ['use file_write.', '`file_write`', 'call file_write(path)', 'FILE_WRITE']) {
      expect(namedTools(text), `must match in: ${text}`).toContain('file_write');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §2 — THE VERDICT COMES FROM THE EXECUTOR'S OWN PREDICATE
// ════════════════════════════════════════════════════════════════════════════════

describe('§2 a warning cannot be false, because the gate decides it', () => {
  it('⚠ THE REPORT: an agent without the file group is reported as unable to do the job', () => {
    agent('file-less', (g) => { g.tools.categories = ['Meta', 'Managing Other Agents']; });
    const out = assignmentCapabilityMismatch('file-less', [
      'Write one short line into ~/notes.txt using file_write.',
    ]);
    expect(out.missing, 'the one tool the assignment names, and it cannot call it')
      .toContain('file_write');
  });

  it('an agent that HOLDS the group produces no warning at all', () => {
    agent('capable', (g) => { g.tools.categories = '*'; });
    const out = assignmentCapabilityMismatch('capable', ['use file_write and shell']);
    expect(out.missing, 'no false positives: this agent can do it').toEqual([]);
    expect(out.granted).toContain('file_write');
  });

  it('an unreadable grant record warns about nothing — silence is the safe direction', () => {
    // No agent row at all. A warning on every spawn would teach the spawner to ignore the real
    // ones, which is worse than missing this case (the executor still refuses).
    const out = assignmentCapabilityMismatch('nobody', ['use file_write']);
    expect(out.missing).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §3 — WHAT THE SPAWNER READS
// ════════════════════════════════════════════════════════════════════════════════

describe('§3 the warning is actionable by the agent that gets it', () => {
  beforeEach(() => {
    agent('file-less', (g) => { g.tools.categories = ['Meta', 'Managing Other Agents']; });
  });

  it('names the tools, the assignee, the three remedies, and what it DOES hold', () => {
    const w = mismatchWarning({
      agentId: 'file-less', agentName: 'Scribe',
      texts: ['Write the summary with file_write when you are done.'],
    });
    expect(w).toContain('CAPABILITY MISMATCH');
    expect(w).toContain('file_write');
    expect(w).toContain('Scribe');
    expect(w, 'the three things the spawner can actually do about it')
      .toMatch(/widen the grant.*reassign the work.*reword the task/s);
    expect(w, 'and the same held-groups sentence the executor\'s refusal carries')
      .toContain('grants cover');
  });

  it('says nothing when there is nothing to say', () => {
    expect(mismatchWarning({ agentId: 'file-less', agentName: 'Scribe', texts: ['go and think about it'] }))
      .toBe('');
    expect(mismatchWarning({ agentId: 'file-less', agentName: 'Scribe', texts: [null, undefined] }))
      .toBe('');
  });

  it('caps the list rather than printing every name', () => {
    const many = ['file_write', 'file_read', 'shell', 'exec', 'web_fetch', 'web_search', 'imessage_send'];
    const w = mismatchWarning({
      agentId: 'file-less', agentName: 'Scribe', texts: [`use ${many.join(', ')}`],
    });
    const named = many.filter((t) => w.includes(t));
    expect(named.length, 'at most the cap is named').toBeLessThanOrEqual(MISMATCH_NAMED_MAX);
    expect(w).toMatch(/\+\d+ more/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §4 — THE WIRE
// ════════════════════════════════════════════════════════════════════════════════

describe('§4 the spawn path calls it, on both texts it has', () => {
  const spawnSrc = (): string => readFileSync(join(
    dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'cat', 'agents.ts',
  ), 'utf8');

  it('⚠ WIRE: the instructions AND the delegated task\'s own words are both checked', () => {
    const src = spawnSrc();
    const calls = src.match(/mismatchWarning\(\{[^}]*\}\)/g) ?? [];
    expect(calls.length, 'two texts, two checks: the system prompt and the task row').toBe(2);
    expect(calls.join('\n'), 'the spawner\'s instructions').toContain('args.system_prompt');
    expect(calls.join('\n'), 'and the task row, read where it is already resolved')
      .toMatch(/freshTask\?\.title/);
    // ⚠ NOT an undeclared argument. `spawn_agent` declares `task_id`, not `task`, and the
    // effects-conformance walk refused the first cut of this wiring for reading `args.task` — a
    // handler may only read parameters some tool declares. The task's words come off the ROW.
    expect(src, 'a handler may not read an undeclared parameter').not.toContain('args.task as string');
  });

  it('the warning rides the result the spawner reads, not a log line', () => {
    const src = spawnSrc();
    const contentLine = src.split('\n').find((l) => l.includes('Agent spawned successfully.')) ?? '';
    expect(contentLine, 'it must be in the tool result itself').toContain('mismatchWarning({');
  });
});
