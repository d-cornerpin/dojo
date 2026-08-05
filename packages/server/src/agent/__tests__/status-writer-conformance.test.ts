// PHASE-6 T10 Step 1a — ONE MODULE TRANSITIONS `agents.status`.
//
// ── WHY THIS WALK EXISTS, AND WHY THE PLAN'S OWN GREP COULD NOT WRITE IT ──
//
// The plan inherited "×4, two bypassing" from research 09. T0-SURVEY re-derived it BY
// READING at `d716172` and the honest figure is different in kind, not just in size:
//
//     33 SQL statements assign `agents.status` in non-test source, across 17 modules.
//     2 of them are the declared writer's own body, so 31 statements in 16 modules
//     BYPASSED the one owner — and FIVE of the 31 are MULTI-LINE `UPDATE agents SET`
//     with `status` on a later line, invisible to `grep "UPDATE agents SET status"`.
//
// A hit-line grep is therefore not a census: it under-counts by exactly the class that
// matters most (see THE FIVE-MEMBER CLASS below). This walk reads statements, not lines,
// and its self-tests plant the multi-line shape so the blindness cannot come back.
//
// Re-derived at this task's own HEAD before anything moved (#14 — no task acts on a count
// it did not just derive). Command, unit STATEMENTS:
//
//   node scratch/census.mjs HEAD      (the walk in this file, run standalone)
//     -> 33 statements / 17 modules / 5 multi-line   — reproduces T0-SURVEY exactly
//
// ── WHAT THE RULE IS, AND WHAT IT DELIBERATELY IS NOT ──
//
// The rule is NOT "one file touches the agents table" — the tree writes `agents` all day
// for names, models, config and errors, and a walk that failed on those would be enforcing
// something nobody wrote. The rule is about the STATUS TRANSITION: `agents.status` is the
// fact every other subsystem reads to decide whether an agent is available, wedged, or
// stopped, and it had sixteen writers.
//
// The ENGINE side is what T10 owns and what is re-pointed here (PHASE-6.md §C1's table):
// engine + boot + tool-surface. The gateway / healer / channel / Dreamer rows keep their
// own sweeps (SWEEP-E / F / A / C) and enter the allowlist WITH THEIR OWNER NAMED, so the
// remaining surface is declared rather than discovered, and a NEW writer anywhere fails
// this walk on the day it is written.
//
// ── THE FIVE-MEMBER CLASS: ONE ROW, NOT FIVE SITES ──
//
// `imaginer-agent.ts` · `healer-agent.ts` · `pm-agent.ts` · `vault/maintenance.ts` ·
// `trainer-agent.ts` each carry the SAME byte-shaped singleton re-enrolment upsert —
// `UPDATE agents SET` / name, model_id, `status='idle'`, agent_type, parent_agent — one per
// singleton service agent, all five spanning multiple lines. Research 09 recorded it for the
// Imaginer alone ("groups.ts re-enrols it every boot") and no plan document has ever named
// the other four as the same mechanism. It is ONE class; the individual excisions belong to
// the sweeps that own those modules. This walk names the class and pins its membership at
// five in BOTH directions, so a sixth service agent cannot join it silently.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// PHASE-6 GUARD-AUDIT: the engine corpus is derived ONCE, never by path (see the clause
// below — this walk's negative half must not go quiet when a tranche moves its subject).
import { engineText } from '../v2/__tests__/engine-sources.js';

const SRC = path.join(__dirname, '..', '..');

/** THE ONE OWNER. Every `agents.status` transition in the engine goes through this module. */
const STATUS_OWNER_MODULE = 'agent/agent-status.ts';

/**
 * The modules that still carry their own `agents.status` write, each with the sweep that
 * owns its excision. T10 lands the ENGINE side; these are declared, not forgotten, and the
 * walk below asserts this map EXACTLY in both directions — a new writer fails, and so does
 * a stale entry for a module a sweep has already converted.
 */
const SWEEP_OWNED_WRITERS: Record<string, string> = {
  'gateway/routes/agents.ts': 'SWEEP-E — the dashboard doors',
  'healer/auto-fix.ts': 'SWEEP-F — the Healer (T10 lands the engine side only)',
  'healer/healer-agent.ts': 'SWEEP-F — the Healer, + one member of the re-enrolment class',
  'services/imessage-commands.ts': 'SWEEP-A — the channel commands',
  'vault/maintenance.ts': 'SWEEP-C — the Dreamer, + one member of the re-enrolment class',
  'imaginer/imaginer-agent.ts': 'SWEEP-G — the Imaginer (re-enrolment class)',
  'tracker/pm-agent.ts': 'SWEEP-F — the PM (re-enrolment class)',
  'techniques/trainer-agent.ts': 'SWEEP-D — the Trainer (re-enrolment class)',
};

/** THE FIVE-MEMBER CLASS, named once. Membership is pinned in both directions below. */
const RE_ENROLMENT_CLASS: readonly string[] = [
  'healer/healer-agent.ts',
  'imaginer/imaginer-agent.ts',
  'techniques/trainer-agent.ts',
  'tracker/pm-agent.ts',
  'vault/maintenance.ts',
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) acc.push(fp);
  }
  return acc;
}

const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
const sourceFiles = (): string[] => walk(SRC).map(rel).sort();
const read = (r: string): string => fs.readFileSync(path.join(SRC, r), 'utf8');

/** Blank comments, keeping line count, so PROSE describing a write is never counted as one. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

/**
 * The SET segment of every `UPDATE agents` statement in `text`.
 *
 * T0-SURVEY's method, reproduced exactly so this walk and the survey's figure are the same
 * measurement: from each `UPDATE agents` line take a SIX-LINE window and keep the part
 * BEFORE its `WHERE`. Six lines rather than "to the end of the line" is the single decision
 * that makes this a census instead of a grep — five of the tree's writers put `status` on a
 * later line — and cutting at `WHERE` rather than at a quote is the second: the SET lists
 * are full of `'idle'` and a quote-terminated capture stops inside the statement it is
 * trying to read.
 */
function setSegments(text: string): string[] {
  const lines = stripComments(text).split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/UPDATE\s+agents\b/i.test(lines[i])) continue;
    out.push(lines.slice(i, i + 6).join('\n').split(/\bWHERE\b/i)[0]);
  }
  return out;
}

/** COUNT the `UPDATE agents` statements whose SET list assigns `status`. Unit: STATEMENTS. */
function countStatusWrites(text: string): number {
  return setSegments(text).filter((s) => /\bstatus\s*=/i.test(s)).length;
}

const writesStatus = (text: string): boolean => countStatusWrites(text) > 0;

describe('T10 Step 1a — the status writers are a declared set, not a discovery', () => {
  it('THE CENSUS: every module that assigns agents.status is the owner or a named sweep row', () => {
    const measured: Record<string, string> = {};
    for (const f of sourceFiles()) {
      if (!writesStatus(read(f))) continue;
      measured[f] = f === STATUS_OWNER_MODULE
        ? 'THE OWNER'
        : (SWEEP_OWNED_WRITERS[f] ?? 'UNDECLARED — a new bypassing writer');
    }
    expect(measured).toEqual({
      [STATUS_OWNER_MODULE]: 'THE OWNER',
      ...SWEEP_OWNED_WRITERS,
    });
  });

  it('the ENGINE, BOOT and TOOL-SURFACE modules T10 re-pointed write no status of their own', () => {
    // §C1's first two rows, by name. These are the thirteen statements T10 re-pointed; if any
    // of them grows a private UPDATE again, this names the file on the day it happens.
    for (const f of [
      'agent/errors.ts', 'agent/rate-limit-retry.ts', 'agent/runtime.ts', 'agent/spawner.ts',
      'index.ts',
      'agent/tools/cat/agents.ts', 'agent/tools/cat/media.ts', 'agent/tools/cat/session.ts',
    ]) expect(countStatusWrites(read(f)), `${f} bypasses the status owner`).toBe(0);
    // THE ENGINE is read through the SHARED CORPUS, never `agent/v2/loop.ts` by path
    // (GUARD-AUDIT, and its census refused this clause when it was written by path): this is
    // a NEGATIVE clause, and a negative clause over a file the phase is draining stops
    // seeing its subject SILENTLY. Driver + every step package, so the rule holds across
    // cuts by construction — and it is strictly stronger, because a step package growing its
    // own status write fails here too.
    expect(countStatusWrites(engineText()), 'the engine bypasses the status owner').toBe(0);
  });

  it('the owner module is NOT vacuous — it holds every status shape the tree writes', () => {
    const owner = read(STATUS_OWNER_MODULE);
    expect(writesStatus(owner)).toBe(true);
    // The three one-row shapes, each expressed exactly as its callers wrote it, plus the
    // boot sweep. A "one owner" that could only express one of them would have forced the
    // other two to stay outside, which is how the surface grew back last time.
    expect(owner).toMatch(/last_error\s*=\s*NULL/);
    expect(owner).toMatch(/last_error\s*=\s*\?/);
    expect(owner).toMatch(/WHERE status = 'working'/);
  });

  it('the owner is reachable WITHOUT importing the engine — the cycle hack is retired', () => {
    // `rate-limit-retry.ts` used `await import('./v2/loop.js')` for one call, with its reason
    // written in place: model.ts imports it and loop.ts imports model.ts, so a static edge
    // closed a cycle. A leaf owner dissolves that, and the dynamic import is gone.
    // Comments stripped first, on the `work-reaper.test.ts` precedent: the site's own note
    // NAMES the retired shape — that is what a landmine note is for — so a raw text match
    // would either fail on the warning or force the warning to be written without its name.
    // The question is whether the dynamic import is back in the CODE.
    const rl = stripComments(read('agent/rate-limit-retry.ts'));
    expect(rl).toMatch(/from '\.\/agent-status\.js'/);
    expect(rl).not.toMatch(/await import\('\.\/v2\/loop\.js'\)/);
    // POSITIVE CONTROL: the stripper did not just blank the file.
    expect(rl).toMatch(/setAgentStatus\(agentId, 'rate_limited'\)/);
    // The owner imports no engine module: it is a leaf, which is what makes it importable
    // from boot, the tool surface and the retry manager alike.
    const ownerImports = read(STATUS_OWNER_MODULE).match(/from '[^']+'/g) ?? [];
    expect(ownerImports.filter((i) => /v2\/loop|\/runtime|\/spawner/.test(i))).toEqual([]);
  });
});

describe('T10 Step 1a — the five-member re-enrolment class, named once', () => {
  /** The class's own shape: one `UPDATE agents SET` carrying status AND model_id AND
   *  agent_type — a singleton being RE-ENROLLED, not an agent changing state. */
  const hasReEnrolmentUpsert = (text: string): boolean => setSegments(text).some(
    (s) => /\bstatus\s*=/i.test(s) && /\bmodel_id\s*=/i.test(s) && /\bagent_type\s*=/i.test(s),
  );

  it('membership is exactly five, in BOTH directions', () => {
    const measured = sourceFiles().filter((f) => hasReEnrolmentUpsert(read(f))).sort();
    expect(measured).toEqual([...RE_ENROLMENT_CLASS].sort());
  });

  it('every member is on the sweep allowlist with an owner — the class is not orphaned', () => {
    for (const f of RE_ENROLMENT_CLASS) {
      expect(SWEEP_OWNED_WRITERS[f], `${f} is in the class but has no named owner`).toBeTruthy();
    }
  });
});

describe('T10 Step 1a — the walk SEES what the plan\'s grep could not', () => {
  it('PLANTED FAULT: a MULTI-LINE UPDATE agents SET is counted — the five-member shape', () => {
    // Verbatim shape of the class the one-line grep missed all five times.
    const multiline = [
      'db.prepare(`',
      '  UPDATE agents SET',
      "    name = ?, model_id = ?, status = 'idle',",
      "    agent_type = 'persistent', parent_agent = NULL",
      '  WHERE id = ?',
      '`).run(name, modelId, id);',
    ].join('\n');
    expect(countStatusWrites(multiline)).toBe(1);
    // …and the grep the plan carried does NOT see it, which is why this file exists.
    expect(/UPDATE agents SET status/.test(multiline)).toBe(false);
  });

  it('PLANTED FAULT: a fresh single-line bypassing writer is counted', () => {
    expect(countStatusWrites(
      `db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(id);`,
    )).toBe(1);
  });

  it('a non-status UPDATE agents is NOT this walk\'s business', () => {
    expect(countStatusWrites("db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(n, id)")).toBe(0);
    expect(countStatusWrites("db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(c, id)")).toBe(0);
    // a READ of the column is not a write
    expect(countStatusWrites("db.prepare('SELECT status FROM agents WHERE id = ?').get(id)")).toBe(0);
    // and a WHERE-clause mention is not a SET
    expect(countStatusWrites("db.prepare(\"UPDATE agents SET name = ? WHERE status = 'idle'\").run(n)")).toBe(0);
  });

  it('SELF-TEST: prose describing a write is not counted as one', () => {
    expect(countStatusWrites("// this used to be UPDATE agents SET status = 'idle' WHERE id = ?")).toBe(0);
    expect(countStatusWrites("/* UPDATE agents SET status = 'error' */")).toBe(0);
    // POSITIVE CONTROL: the stripper does not blank real code.
    expect(countStatusWrites("const q = `UPDATE agents SET status = ? WHERE id = ?`; // note")).toBe(1);
  });
});
