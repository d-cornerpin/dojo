// PHASE-2 T3 Step 3 — the `conv_key IS NULL` inventory, as a gate rather than a grep.
//
// "A string scan is not a completion proof." Every surviving occurrence of the predicate
// that USED to be this platform's work queue is resolved BY READING to the mechanism that
// owns it, and that resolution is written down here as an exact map. The map is enforced in
// BOTH directions, so:
//   * a NEW `conv_key IS NULL` anywhere in the tree fails this test, and
//   * a stale entry for a site a later task has already removed fails it too.
// When the map is empty, the column's claim job is gone from the tree entirely.
//
// ⚠ IT WALKS THE WHOLE REPOSITORY, INCLUDING `watchdog/`, AND THAT IS THE POINT.
// PHASE-1's worst near-miss was a `packages/`-scoped scan that left watchdog supervision
// silently dead for a day, because the watchdog deliberately lives outside `packages/`.
// A scan that stops at `packages/` cannot see the file this test exists to keep honest.
//
// ── WHAT T3 MEASURED, AND WHERE IT DISAGREES WITH THE PLAN (#14: fix the plan) ──
// PHASE-2.md PINNED §1 buckets 16 live SQL sites as "the `conv_key IS NULL` queue
// predicate" and T3 Step 3 reads "delete the 16". Read one by one against the code, they
// are not 16 instances of one mechanism — they are FOUR mechanisms sharing one spelling:
//
//   A. the OWNER-ASK queue          -> T3's, and it is GONE (5 sites)
//   B. the ENGINE-EVENT claim/queue -> a different queue with its own retry lifecycle
//                                      (T6 owns the policy, T9 the single reaper)
//   C. the A2A terminal-wake claim  -> the peer lane (T4), and it is GONE TOO (see below)
//   D. conversation IDENTITY        -> requirement 3l says this half STAYS first-class;
//                                      it dies with the column at T10
//   ...plus one that is not on `messages` at all.
//
// ── WHAT T4 REMOVED (2026-07-28) ──
// Bucket C is empty. The terminal A2A wake was claimed by stamping `conv_key='a2a'` — a
// sentinel that is not a conversation, written onto the column that carries conversation
// IDENTITY, purely so `findUnservedTerminalWake`'s `conv_key IS NULL` predicate would stop
// returning the row. Both halves are gone: the finder reads `served_by_turn IS NULL` (the real
// serve edge, already stamped on that row by the same turn) and the sentinel write is deleted.
// `counterparty.ts` therefore drops from 2 to 1 — the survivor is bucket B's
// DELIVERABLE_ENGINE_EVENT_WHERE. `message-store.ts` stays at 5 because the `expect: null`
// branch it shares is still the ENGINE-EVENT pickup's; T4 is no longer one of its owners.
//
// Deleting B, C or D here would not be a demolition; it would be a hole where a live
// mechanism used to be, with no replacement built and no task claiming to have built one
// (roadmap #15: a deletion may never rest on an absence). So T3 removes A, names the owner
// of every survivor from the plan's own text, and records the correction rather than
// quietly satisfying a number.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** `packages/server/src/work/__tests__` -> the repository root. */
const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ROOTS = [
  'packages/server/src',
  'packages/shared/src',
  'packages/dashboard/src',
  'watchdog/src',
];

const PREDICATE = /conv_key IS NULL/gi;

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Migrations are OUT of scope by construction: 078/082/084/098/105 READ this
      // predicate as historical data statements and re-writing a shipped migration is how
      // an upgrade path breaks (research 07 §2, "migration-order hazard").
      if (e.name === 'migrations' || e.name === 'node_modules' || e.name === 'dist') continue;
      walk(fp, acc);
    } else if (e.name === 'conv-key-inventory.test.ts') {
      // This file carries the predicate as literals — in the self-test's planted strings
      // and in the assertions below — and counting itself would make the map self-fulfilling.
      continue;
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) acc.push(fp);
  }
  return acc;
}

/** Blank comments, keeping line count, so PROSE describing the predicate is never counted
 *  as a live one. Six comments mention it on purpose; they are documentation of the
 *  demolition, not the mechanism. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length))
  .replace(/^\s*--[^\n]*/gm, (m) => ' '.repeat(m.length));

function measure(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const root of ROOTS) {
    for (const f of walk(path.join(REPO, root))) {
      const n = (stripComments(fs.readFileSync(f, 'utf8')).match(PREDICATE) ?? []).length;
      if (n > 0) out[path.relative(REPO, f).split(path.sep).join('/')] = n;
    }
  }
  return out;
}

// ── THE SURVIVORS, each with the mechanism it belongs to and the task that owns it ──
// Every entry below was opened and read at T3, not inherited from a list.
const RESOLVED: Record<string, number> = {
  // B + D, all in the message writer:
  //   :570 setConvKeyByRowid's `expect: null` branch — the CAS for the ENGINE-EVENT pickup
  //        (value 'engine', owner T6/T9). The owner-ask caller went at T3 and the terminal
  //        A2A wake caller went at T4; this one remains, with one owner instead of two.
  //   :593 tagTurnOutputConvKey — "do not re-tag an already-tagged output row". IDENTITY.
  //   :629 claimTrackerNoticeForTask — retires an assignment notice. PHASE-2 T8c DISPOSED of
  //        this one and the verdict is KEEP-AND-SCOPE, with the measurement in the
  //        function's own docblock: on the owner's real backup body 185 assignment notices
  //        carry NO task_id and 14 are STILL UNCLAIMED, so the keyed retirement
  //        (`sweepByReferent{referent:'task_id'}`) cannot reach them and deleting this arm
  //        would leave them to be re-delivered as fresh "begin working on this task"
  //        prompts. The dev box's count of 0 is the absence #15 forbids reading as death.
  //        Scoped to `task_id IS NULL` so the two arms no longer both claim one row; it
  //        retires when the Bridge's pre-112 rows are gone (T12/Bridge, not Phase 2).
  //   :674 sweepByRowid(requireUnclaimed) and :689 sweepByReferent — the ENGINE-EVENT serve
  //        boundary ("a row already claimed by a turn is not ours to sweep"). T6/T9.
  'packages/server/src/memory/message-store.ts': 5,
  // D — conversation-scoped recall. The comment at :275 states the requirement exactly:
  // an untagged row is this turn's own scratch, and a bare `conv_key IS NULL` would bleed
  // ANOTHER human's unclaimed inbound into this recall (inv 4). 3l keeps this half
  // first-class; it dies with the column at T10.
  'packages/server/src/memory/recall.ts': 2,
  // B — the boot staleness sweep's ENGINE-EVENT arm. T3 split this block in two and took
  // the owner-ask arm onto the work spine; the engine arm keeps its own claim column.
  'packages/server/src/index.ts': 1,
  // B (:345 DELIVERABLE_ENGINE_EVENT_WHERE, T6). C (findUnservedTerminalWake) was the second
  // one and T4 removed it — the finder reads `served_by_turn IS NULL` now.
  'packages/server/src/agent/v2/counterparty.ts': 1,
  // ── REMOVED BY T7 (2026-07-29) ──
  // `packages/server/src/memory/open-loops.ts` carried ONE occurrence and it was never on
  // `messages` at all: it was `open_loops.conv_key`, the dedup key of the prose-parsed
  // open-loops store. PINNED §1 counted it among the "live SQL predicates in production",
  // which is why it had an entry here — a predicate, on a different table, doing a different
  // job. T7 deleted the module (623 lines) and migration `136_drop_open_loops.sql` deleted the
  // table, so the site is gone rather than re-pointed. The other site this file used to name
  // in that module (`:123`, the store-contradiction probe) was already rekeyed onto the work
  // lookup by T3 and is asserted below.
  //
  // The conformance test that PINS the engine-event serve boundary's SQL. PHASE-2.md
  // predicted this assertion "fails by design when T3 lands"; it does not, and the reason
  // is the correction above: what it pins is sweepByReferent, which is bucket B.
  'packages/server/src/tracker/__tests__/serve-boundary-conformance.test.ts': 1,
};

describe('PHASE-2 T3 — the conv_key claim predicate, resolved site by site', () => {
  it('every live occurrence in the WHOLE REPO is on the resolved map, with its exact count', () => {
    expect(measure()).toEqual(RESOLVED);
  });

  it('the OWNER-ASK queue no longer reads it — the five sites T3 owned are gone', () => {
    const src = (rel: string): string => stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'));

    // 1. the waiting set
    const cp = src('packages/server/src/agent/v2/counterparty.ts');
    const waiting = cp.slice(cp.indexOf('const WAITING_HUMAN_CANDIDATE_WHERE'), cp.indexOf('function originOfCandidate'));
    expect(waiting).not.toMatch(/conv_key/);
    expect(waiting).toMatch(/w\.kind = 'ask' AND w\.state = 'open'/);

    // 2. the sibling batch-claim's row guard
    const store = src('packages/server/src/memory/message-store.ts');
    const claimRow = store.slice(store.indexOf('export function claimRowByRowid'));
    expect(claimRow.slice(0, 500)).not.toMatch(/conv_key IS NULL/);

    // 3. the "is anything unserved" probe behind the store-contradiction guard.
    //    T3 rekeyed it onto the work lookup; T7 deleted the module it lived in, guard and all,
    //    because the parser it defended is gone. Asserted as an ABSENCE with its replacement
    //    named, not as a bare "grep found nothing" (#15): the requirement is preserved by the
    //    creation door, and `work/__tests__/commitment-lifecycle.test.ts` is where that is proven.
    expect(fs.existsSync(path.join(REPO, 'packages/server/src/memory/open-loops.ts'))).toBe(false);
    expect(src('packages/server/src/work/store.ts'))
      .toMatch(/kind IN \$\{OBLIGATION_KINDS\}/);

    // 4. the watchdog's unanswered-human backlog — OUTSIDE `packages/`, named explicitly
    const wd = src('watchdog/src/index.ts');
    expect(wd).not.toMatch(/conv_key/);
    expect(wd).toMatch(/JOIN work w ON w\.agent_id = a\.id/);

    // 5. the boot staleness sweep's human arm
    const idx = src('packages/server/src/index.ts');
    expect(idx).toMatch(/w\.kind = 'ask' AND w\.state = 'open'/);
    // ...and what is left of that block is explicitly the events lane, not "any user row".
    expect(idx).toMatch(/m\.role = 'user' AND m\.lane = 'events'\s+AND m\.conv_key IS NULL/);
  });

  it('T4: the terminal A2A wake is claimed by the SERVE edge, and the fake conversation key is gone', () => {
    const src = (rel: string): string => stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    const cp = src('packages/server/src/agent/v2/counterparty.ts');
    const finderStart = cp.indexOf('export function findUnservedTerminalWake');
    const finder = cp.slice(finderStart, cp.indexOf('export function', finderStart + 10));
    expect(finder).toMatch(/served_by_turn IS NULL AND swept_at IS NULL/);
    expect(finder).not.toMatch(/conv_key/);
    // ...and nothing in the tree writes the sentinel any more. NEGATIVE CONTROL: the OTHER
    // sentinel writes ('engine') must still be here, or this clause would pass by deleting
    // the wrong thing.
    const loop = src('packages/server/src/agent/v2/loop.ts');
    expect(loop).not.toMatch(/value: 'a2a'/);
    expect(loop).toMatch(/value: 'engine', expect: null/);
    // The serve stamp is GATED on the wake actually driving the turn. Ungated, it would mark a
    // wake served that LOST the turn to a waiting human — swallowing it — because that stamp
    // is now the finder's own predicate. This clause is what stops the gate being "tidied" away.
    expect(loop).toMatch(/if \(terminalWakeA2A && terminalWakeDrivesTurn\) \{\s*\n\s*markServedByRowid/);
  });

  it('the pickup claim is a work-state CAS whose LOSER is the D-2 bail', () => {
    const loop = stripComments(fs.readFileSync(path.join(REPO, 'packages/server/src/agent/v2/loop.ts'), 'utf8'));
    expect(loop).toMatch(/const res = claimAsk\(triggerWorkId, agentId\)/);
    expect(loop).toMatch(/claimed = res\.kind === 'applied'/);
    expect(loop).toMatch(/pickup claim lost, another process already claimed this trigger/);
    // The revert is P6b-gated at the REVERT, not at each caller that remembers to check.
    expect(loop).toMatch(/revertAskClaimOnAbort\(\s*triggerWorkId, state\.nonIdempotentCallsThisTurn/);
  });

  it('SELF-TEST: the scanner sees a planted predicate and ignores a commented one', () => {
    expect(stripComments('const q = `WHERE conv_key IS NULL`;').match(PREDICATE)).toHaveLength(1);
    expect(stripComments('// WHERE conv_key IS NULL').match(PREDICATE)).toBeNull();
    expect(stripComments('  -- WHERE conv_key IS NULL').match(PREDICATE)).toBeNull();
    expect(stripComments('/* WHERE conv_key IS NULL */').match(PREDICATE)).toBeNull();
  });

  it('SELF-TEST: the walk actually reaches outside packages/', () => {
    const files = walk(path.join(REPO, 'watchdog/src'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('watchdog/src/index.ts'))).toBe(true);
  });
});
