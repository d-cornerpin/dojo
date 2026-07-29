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
  // ── BUCKET B IS EMPTY (PHASE-2 T9, 2026-07-29). ──
  // T6 owed this and named T9 the owner: the five ENGINE-EVENT sites re-expressed on
  // `served_by_turn IS NULL` before T10 drops the column, exactly the rekey T4 performed for
  // the terminal A2A wake. All five moved, and the fifth one had a trap in it:
  //   * `DELIVERABLE_ENGINE_EVENT_WHERE`   (counterparty.ts)  -> `served_by_turn IS NULL`
  //   * `sweepByRowid(requireUnclaimed)`   (message-store.ts) -> `served_by_turn IS NULL`
  //   * `sweepByReferent`                  (message-store.ts) -> `served_by_turn IS NULL`
  //   * the boot staleness sweep's engine arm — moved WHOLE into `work/work-reaper.ts`
  //     (`sweepBootStaleness`), predicate on `served_by_turn IS NULL`
  //   * the pickup CAS `setConvKeyByRowid({value:'engine', expect:null})` -> the atomic claim
  //     is `claimEngineEventByRowid` at turn-identity allocation, its revert is
  //     `releaseEngineEventByRowid`, and the `expect` parameter is STRIPPED because it had no
  //     caller left.
  // ⚠ AND THE ONE THAT WOULD HAVE GONE WRONG SILENTLY: `claimTrackerNoticeForTask` WROTE the
  // sentinel `conv_key='engine'` to retire a legacy assignment notice, and only worked
  // because eligibility asked `conv_key IS NULL`. Moving eligibility without moving the
  // writer would have left the sentinel excluding nothing and re-delivered the 14 still
  // unclaimed pre-112 notices on the owner's real body as fresh "begin working on this task"
  // prompts. It writes `swept_at` now — the same retirement the keyed arm already used.
  //
  // What is LEFT in the message writer is bucket D only:
  //   tagTurnOutputConvKey — "do not re-tag an already-tagged output row". IDENTITY.
  'packages/server/src/memory/message-store.ts': 1,
  // D — conversation-scoped recall. The comment at :275 states the requirement exactly:
  // an untagged row is this turn's own scratch, and a bare `conv_key IS NULL` would bleed
  // ANOTHER human's unclaimed inbound into this recall (inv 4). 3l keeps this half
  // first-class; it dies with the column at T10.
  'packages/server/src/memory/recall.ts': 2,
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
  // (The serve-boundary conformance test's copy of this predicate went with bucket B — it
  // now pins `served_by_turn IS NULL AND swept_at IS NULL`, the same requirement on the
  // column that means it.)
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

    // 5. the boot staleness sweep's human arm. T9 moved the whole sweep out of the boot
    //    sequence and into the one reaper; both arms travelled unchanged except for the
    //    engine arm's predicate, which is bucket B's rekey.
    const reaper = src('packages/server/src/work/work-reaper.ts');
    expect(reaper).toMatch(/w\.kind = 'ask' AND w\.state = 'open'/);
    // ...and what is left of that block is explicitly the events lane, not "any user row".
    expect(reaper).toMatch(/m\.role = 'user' AND m\.lane = 'events'\s+AND m\.served_by_turn IS NULL/);
    // ...and the block is GONE from the boot sequence rather than copied out of it.
    expect(src('packages/server/src/index.ts')).not.toMatch(/Boot staleness sweep: drain-suppressed/);
  });

  it('T9: the ENGINE-EVENT claim is the serve edge, and the conv_key sentinel is gone', () => {
    const src = (rel: string): string => stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    const cp = src('packages/server/src/agent/v2/counterparty.ts');
    expect(cp).toMatch(/lane = 'events' AND served_by_turn IS NULL/);
    // Nothing writes the 'engine' sentinel any more. NEGATIVE CONTROL: the identity stamp
    // that legitimately puts 'engine' on a turn's OWN OUTPUT rows must still be here, or this
    // clause would pass by deleting the wrong thing — the re-answer guard and the assembler
    // both read that stamp to tell engine chatter from a human conversation.
    const store = src('packages/server/src/memory/message-store.ts');
    expect(store).not.toMatch(/SET conv_key = 'engine'/);
    const loop = src('packages/server/src/agent/v2/loop.ts');
    expect(loop).not.toMatch(/value: 'engine', expect: null/);
    expect(loop).toMatch(/isEngineTurn \? 'engine'/);
    // The claim and its revert are a matched CAS pair on one column.
    expect(store).toMatch(/SET served_by_turn = @turnNumber\s+WHERE rowid = @rowid AND agent_id = @agentId AND served_by_turn IS NULL/);
    expect(store).toMatch(/SET served_by_turn = NULL\s+WHERE rowid = @rowid AND agent_id = @agentId AND served_by_turn = @turnNumber/);
    // And `setConvKeyByRowid` no longer offers a claim guard to anybody.
    const setter = store.slice(store.indexOf('export function setConvKeyByRowid'));
    expect(setter.slice(0, 500)).not.toMatch(/expect/);
  });

  it('T9: the LEGACY assignment-notice arm retires by the same edge, not by the sentinel', () => {
    // If this arm had been left writing `conv_key='engine'` while eligibility moved to
    // `served_by_turn`, the 14 still-unclaimed pre-112 notices on the owner's real body would
    // have become re-deliverable. It writes `swept_at` now — what the KEYED arm always wrote.
    const store = stripComments(fs.readFileSync(path.join(REPO, 'packages/server/src/memory/message-store.ts'), 'utf8'));
    const fn = store.slice(store.indexOf('export function claimTrackerNoticeForTask'));
    expect(fn.slice(0, 1800)).toMatch(/SET swept_at =/);
    expect(fn.slice(0, 1800)).toMatch(/served_by_turn IS NULL AND swept_at IS NULL/);
    expect(fn.slice(0, 1800)).toMatch(/task_id IS NULL/);   // the scope T8c measured and kept
  });

  it('T4: the terminal A2A wake is claimed by the SERVE edge, and the fake conversation key is gone', () => {
    const src = (rel: string): string => stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    const cp = src('packages/server/src/agent/v2/counterparty.ts');
    const finderStart = cp.indexOf('export function findUnservedTerminalWake');
    const finder = cp.slice(finderStart, cp.indexOf('export function', finderStart + 10));
    expect(finder).toMatch(/served_by_turn IS NULL AND swept_at IS NULL/);
    expect(finder).not.toMatch(/conv_key/);
    // ...and nothing in the tree writes the sentinel any more.
    //
    // NEGATIVE CONTROL, RE-EXPRESSED (PHASE-2 T9). T4 pinned "the OTHER sentinel write
    // (`value: 'engine', expect: null`) must still be here", so that this clause could not
    // pass by somebody deleting every conv_key write. T9 removed exactly that write — it was
    // the engine-event pickup claim, the last claim job on the column — so the control has to
    // point at what genuinely survives instead of at a demolished mechanism. The surviving
    // write is the one requirement 3l keeps: the trigger row's conversation IDENTITY stamp.
    const loop = src('packages/server/src/agent/v2/loop.ts');
    expect(loop).not.toMatch(/value: 'a2a'/);
    expect(loop).toMatch(/setConvKeyByRowid\(\{ rowid: triggerRow\.rowid, agentId, value: chosenConvKey \}\)/);
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
