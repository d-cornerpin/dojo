// ════════════════════════════════════════════════════════════════════════════════════════
// HL4 STEP 2 (2c) — THE SECOND STEERING CHANNEL IS GOVERNED.
//
// W27's census §5.7 called this "THE BIG ONE" and refused to decide it inside a census: some
// queue floors write their steer's text to the events lane as well, and the events lane has
// none of the queue's three properties — no priority, no latch, no budget. `lane.events`
// takes rows by recency (`memory/assembler.ts`), so an engine directive reaches the model
// once as a steer this turn and again as an events line next turn, and nothing dedups.
//
// THIS SUITE DID NOT STOP THE SECOND WRITE; it made the pairing DECLARED, BOUNDED and
// CONTENT-IDENTICAL, so the design call the census handed up was one edit away instead of
// seven — and so an eighth double-writer cannot land unnoticed, which is the whole disease.
//
// RED at `e8b7b56`: §1 failed. The inherited count was SIX (the plan's own sentence, and the
// census's list) and the tree carried SEVEN — `thrash-*` is two floors with two steers.
// A hand-counted set drifts; this clause is what stops it.
//
// ── T53 (owner ruling 5, 2026-08-16): THE DESIGN CALL CAME BACK, AND IT IS "CLEAN UP" ──
// The pairs are being retired one site at a time, each in its own commit. `QUEUE_PAIRED_RIDERS`
// is the LEDGER of what is left: a site that stops writing the events lane must leave the map
// in the same commit (the second direction below fails otherwise), and a site that keeps the
// pair must stay declared (the first direction). The suite's own job is unchanged — it is what
// makes a new double-writer impossible — and the argument for which channel goes is measured
// in `the-second-channel-stops-double-writing.test.ts`, not asserted here.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_RIDER_INTENTS, QUEUE_PAIRED_RIDERS } from '../engine-riders.js';
import { STEER_PRECEDENCE } from '../steer-queue.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..');

/** Blank comments while keeping line count, so PROSE ABOUT a write is never counted as one.
 *  Same idiom, and the same recorded reason, as `engine-rider-never-drives-a-turn.test.ts`:
 *  a source scan that cannot tell a mechanism from a sentence about it measures the wrong
 *  thing — and this file's own declaration is 40 lines of prose naming every intent. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

function engineFiles(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(fp); continue; }
      if (!e.name.endsWith('.ts') || e.name.includes('.test.')) continue;
      out.push({ rel: path.relative(ENGINE, fp).split(path.sep).join('/'), text: stripComments(fs.readFileSync(fp, 'utf8')) });
    }
  };
  walk(ENGINE);
  return out;
}

/**
 * EVERY events-lane write in the engine, each with the window that belongs to it: from its
 * own call up to the NEXT such write (or 6 KB, whichever is smaller). The cap at the next
 * write is what keeps one site's steer from being attributed to the site above it —
 * `thrash-gate.ts` has three writes and only two of them file a steer, so a fixed forward
 * window would pair the turn-ending block that deliberately files none.
 */
function eventWrites(): Array<{ where: string; rel: string; text: string; at: number; window: string }> {
  const out: Array<{ where: string; rel: string; text: string; at: number; window: string }> = [];
  for (const { rel, text } of engineFiles()) {
    let idx = text.indexOf('insertEngineEventIfAbsent(');
    while (idx !== -1) {
      const next = text.indexOf('insertEngineEventIfAbsent(', idx + 1);
      const end = Math.min(next === -1 ? text.length : next, idx + 6000);
      out.push({
        where: `${rel}:${text.slice(0, idx).split('\n').length}`,
        rel, text, at: idx, window: text.slice(idx, end),
      });
      idx = next;
    }
  }
  return out;
}

/** The floor a window files a steer for — read off the QUEUE CALL, never off a bare
 *  `floor:` key (`recordFloorGhost` has one too, and it is not a steer). */
function steerFloorIn(window: string): { floor: string; content: string } | null {
  const call = /(?:enqueueSteer|persistEngineSteer)\(([\s\S]{0,400})/.exec(window);
  if (!call) return null;
  const floor = /floor: '([a-z0-9-]+)'/.exec(call[1])?.[1];
  const content = /content:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(call[1])?.[1];
  return floor ? { floor, content: content ?? '' } : null;
}

/** DERIVE the double-writers: an events-lane write whose own block also files a steer. */
function derivedPairs(): Array<{ where: string; floor: string; intent: string; content: string }> {
  const found: Array<{ where: string; floor: string; intent: string; content: string }> = [];
  for (const w of eventWrites()) {
    const intent = /originIntent: '([a-z0-9_]+)'/.exec(w.window)?.[1];
    const steer = steerFloorIn(w.window);
    if (intent && steer) found.push({ where: w.where, floor: steer.floor, intent, content: steer.content });
  }
  return found;
}

describe('§1 the pairing is DECLARED, and derived from the writers rather than hand-counted', () => {
  it('every floor that writes BOTH channels is in `QUEUE_PAIRED_RIDERS`, and nothing else is', () => {
    const derived = derivedPairs();
    // Non-vacuity, and T53 moved where it has to live. It used to be a floor on the PAIR
    // count (`>= 7`), which was right while seven was the answer; the owner's ruling 5 is
    // that the pairs go, one site at a time, so a floor on them would forbid the cleanup
    // this file exists to police. The floor is on the WALK instead: the scan must still be
    // finding events-lane writes, or it is measuring the wrong thing and every clause below
    // it is vacuous. That number cannot fall to zero — the events lane keeps its genuine
    // riders (`thrash_block`, `delegation_hint`, `fanout_join`, every awareness notice).
    // The floor is the engine's GENUINE riders, the ones T53 never touches: the thrash
    // ladder's terminal block (which files no steer at all), the delegation hint, the
    // scaffold-title note and the close-the-loop notice.
    expect(eventWrites().length, 'the walk found no events-lane writes — it is measuring the wrong thing')
      .toBeGreaterThanOrEqual(4);

    const undeclared = derived.filter((p) => QUEUE_PAIRED_RIDERS[p.floor]?.intent !== p.intent);
    // If this fails: a steer floor is writing a SECOND model-facing channel and nothing says
    // so. Declare it in `engine-riders.ts` (with the argument for why it needs the next-turn
    // carrier), or stop the second write.
    expect(undeclared.map((p) => `${p.where} | ${p.floor} → ${p.intent}`)).toEqual([]);

    // …and in the other direction: a declared pair with no writer is a stale declaration.
    const derivedFloors = new Set(derived.map((p) => p.floor));
    expect(Object.keys(QUEUE_PAIRED_RIDERS).filter((f) => !derivedFloors.has(f))).toEqual([]);
  });

  it('every paired intent is a RIDER, never a deliverable — the second channel may not drive a turn', () => {
    const riders = new Set<string>(ENGINE_RIDER_INTENTS);
    for (const p of Object.values(QUEUE_PAIRED_RIDERS)) expect(riders.has(p.intent)).toBe(true);
  });

  it('every paired floor is a floor the precedence table ranks', () => {
    const declared = new Set(STEER_PRECEDENCE.map((f) => f.id));
    for (const floor of Object.keys(QUEUE_PAIRED_RIDERS)) expect(declared.has(floor)).toBe(true);
  });
});

describe('§2 the declared BUDGET: the second channel inherits the queue\'s latch', () => {
  it('every paired site is gated on its own floor\'s latch BEFORE it writes the rider', () => {
    // This is the bound the census found missing on the rider family, and the finding is
    // that it already holds — by construction, at every site, because the rider write sits
    // inside a branch the queue's latch already guards. Declaring and pinning it is what
    // stops an eighth site landing without one.
    //
    // The guard is the DECLARED expression, matched literally. "Some latch is nearby" is
    // not a bound: a `steerFired` read for a different floor would satisfy a loose pattern
    // and prove nothing, which is how an unbounded site would slip through.
    const missing: string[] = [];
    for (const w of eventWrites()) {
      const floor = steerFloorIn(w.window)?.floor;
      const pair = floor ? QUEUE_PAIRED_RIDERS[floor] : undefined;
      if (!floor || !pair) continue;
      // The guard sits ABOVE the write, in the branch that admits it.
      if (!w.text.slice(0, w.at).includes(pair.latch)) missing.push(`${w.where} | ${floor} | expected guard: ${pair.latch}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('§3 the declared CONTENT IDENTITY: one fact, one wording, two carriers', () => {
  it('the rider carries the steer\'s OWN bytes at every paired site', () => {
    // The two channels must never drift into two different instructions about the same
    // fact. Each site builds one string and hands the SAME identifier to both calls; a site
    // that composed a second wording for the events lane would be a second steer text with
    // no floor, no priority and no latch — which is the thing this whole step exists about.
    const mismatched: string[] = [];
    for (const p of derivedPairs()) {
      const w = eventWrites().find((x) => x.where === p.where)!;
      const riderContent = /content:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(w.window)?.[1];
      if (!riderContent || !p.content || riderContent !== p.content) {
        mismatched.push(`${p.where} | ${p.floor}: rider=${riderContent ?? '?'} steer=${p.content || '?'}`);
      }
    }
    expect(mismatched.length, mismatched.join(' · ')).toBe(0);
  });
});
