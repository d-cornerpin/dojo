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
// PHASE-6 GUARD-AUDIT 2026-08-04: the shared engine-corpus derivation (driver + step
// packages). See its header for why a guard must stop naming `agent/v2/loop.ts` by hand.
import { engineText } from '../../agent/v2/__tests__/engine-sources.js';

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

/**
 * PHASE-6 GUARD-AUDIT 2026-08-04 — THE ENGINE, comment-stripped, in place of
 * `src('packages/server/src/agent/v2/loop.ts')`.
 *
 * Three clauses below scanned the driver BY PATH for engine-turn / terminal-wake mechanics
 * that all live inside `runV2TurnBody` and therefore move into `agent/v2/steps/<name>/` as
 * PHASE-6 cuts its tranches. The dangerous half is the NEGATIVE clauses (`not.toMatch` on the
 * `'engine'` and `'a2a'` conv_key sentinels): those pass by default over a corpus that no
 * longer contains the code they forbid, so the sentinel could come back inside a step package
 * and this file — the gate that exists to stop it coming back — would stay green.
 *
 * Widening is strictly stronger in both directions: the negatives now forbid the sentinel
 * across the driver AND every step package, and the positives must still find their subject,
 * merely wherever the tranche put it. `stripComments` is applied exactly as `src()` applies
 * it to one file, so prose about the predicate still never counts as a live one.
 */
const engineSrc = (): string => stripComments(engineText());

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
  // ── ⬛ THE MAP IS EMPTY. PHASE-2 T10I, 2026-07-30. ──
  //
  // This file's own opening line set the exit condition: "When the map is empty, the column's
  // claim job is gone from the tree entirely." It is. Every bucket, with the task that closed
  // it and the column each requirement moved onto:
  //
  //   A. the OWNER-ASK queue          -> T3  -> `work(kind='ask').state = 'open'`
  //   B. the ENGINE-EVENT claim/queue -> T9  -> `messages.served_by_turn IS NULL`
  //   C. the A2A terminal-wake claim  -> T4  -> `messages.served_by_turn IS NULL`
  //      ⚠ and T4 left ONE reader behind, which T10I found: `loop.ts`'s terminal-wake
  //      detection still asked `conv_key === null` for "not yet claimed". It kept working only
  //      because nothing wrote the sentinel any more — i.e. it was reading "unclaimed" off a
  //      column that had stopped recording claims, and a re-introduced identity stamp on that
  //      row would have silently suppressed every terminal wake. Both readers of that edge now
  //      ask `served_by_turn` the same question.
  //   D. conversation IDENTITY        -> T10I -> `messages.conversation_id` (migration `147`
  //      backfilled it through `conversations`' unique key; the two surviving sites here were
  //      `tagTurnOutputConvKey`'s do-not-re-tag guard and conversation-scoped recall, and both
  //      moved to the same `IS NULL` test on the column that means it)
  //
  // ⚠ THIS TEST IS NOT VACUOUS NOW, AND THAT IS DELIBERATE. An empty map is exactly the shape
  // that can pass by measuring nothing, so the selftest below plants the predicate into a real
  // file and requires the walk to see it. The clauses under it keep asserting the REPLACEMENTS
  // positively (#15: a removal may never rest on an absence) — the ticket state, the serve
  // edge, the watchdog's own join, the reaper's lane scope — so this file goes on earning its
  // keep after the column is gone: it is now the gate that stops the predicate coming BACK.
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
    // PHASE-6 GUARD-AUDIT 2026-08-04: corpus widened from the driver alone to THE ENGINE
    // (driver + every step package) — the negative below is a `not.toMatch`, and a negative
    // that stops seeing the code it forbids passes for the wrong reason.
    const loop = engineSrc();
    expect(loop).not.toMatch(/value: 'engine', expect: null/);
    expect(loop).toMatch(/isEngineTurn \? 'engine'/);
    // The claim and its revert are a matched CAS pair on one column.
    expect(store).toMatch(/SET served_by_turn = @turnNumber\s+WHERE rowid = @rowid AND agent_id = @agentId AND served_by_turn IS NULL/);
    expect(store).toMatch(/SET served_by_turn = NULL\s+WHERE rowid = @rowid AND agent_id = @agentId AND served_by_turn = @turnNumber/);
    // And the identity setter no longer offers a claim guard to anybody. PHASE-2 T10I renamed
    // it with its column (`setConvKeyByRowid` -> `stampConversationIdByRowid`); the property
    // this clause pins is unchanged — an identity write carries no compare-and-swap, because
    // every claim is a CAS on the column that records claims.
    const setter = store.slice(store.indexOf('export function stampConversationIdByRowid'));
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
    // NEGATIVE CONTROL, RE-EXPRESSED TWICE, AND BOTH RE-EXPRESSIONS ARE THE HISTORY OF THIS
    // COLUMN. T4 pinned "the OTHER sentinel write must still be here" so the clause could not
    // pass by deleting every conv_key write; T9 removed exactly that write (the engine-event
    // pickup claim); and PHASE-2 T10I moved the last survivor — the trigger row's IDENTITY
    // stamp — onto `conversation_id`. The control therefore points at the identity write that
    // genuinely survives, in its current spelling, so this clause still cannot pass by deleting
    // the wrong thing.
    // PHASE-6 GUARD-AUDIT 2026-08-04: corpus widened from the driver alone to THE ENGINE
    // (driver + every step package). Both the sentinel ban and the terminal-wake readers below
    // sit inside `runV2TurnBody` and move with their tranche; the ban in particular would have
    // gone quiet, which is the exact silence this negative control was written against.
    const loop = engineSrc();
    expect(loop).not.toMatch(/value: 'a2a'/);
    expect(loop).toMatch(/stampConversationIdByRowid\(\{ rowid: triggerRow\.rowid, agentId, conversationId: chosenConversationId \}\)/);
    // ⚠ AND THE ONE T4 MISSED. Its own re-point moved `findUnservedTerminalWake` onto the serve
    // edge, but `loop.ts`'s SECOND reader of "has this wake been claimed" kept asking
    // `conv_key === null`, and it kept working only because nothing wrote the sentinel any
    // more. T10I moved it. Pinned here because the failure mode is silent in the dangerous
    // direction: an identity stamp landing on that row would suppress every terminal wake.
    expect(loop).toMatch(/mostRecentInbound\.served_by_turn === null/);
    // The serve stamp is GATED on the wake actually driving the turn. Ungated, it would mark a
    // wake served that LOST the turn to a waiting human — swallowing it — because that stamp
    // is now the finder's own predicate. This clause is what stops the gate being "tidied" away.
    expect(loop).toMatch(/if \(terminalWakeA2A && terminalWakeDrivesTurn\) \{\s*\n\s*markServedByRowid/);
  });

  it('the pickup claim is a work-state CAS whose LOSER is the D-2 bail', () => {
    // PHASE-6 GUARD-AUDIT 2026-08-04: corpus widened from the driver alone to THE ENGINE
    // (driver + every step package), keeping `stripComments` so prose about the claim is still
    // never read as the claim. The pickup CAS and its P6b-gated revert are turn-body code and
    // move with their tranche; these are presence clauses, so the join is safe and a tranche
    // that deletes rather than moves them still fails here.
    const loop = engineSrc();
    expect(loop).toMatch(/const res = claimAsk\(triggerWorkId, agentId\)/);
    expect(loop).toMatch(/claimed = res\.kind === 'applied'/);
    expect(loop).toMatch(/pickup claim lost, another process already claimed this trigger/);
    // The revert is P6b-gated at the REVERT, not at each caller that remembers to check.
    expect(loop).toMatch(/revertAskClaimOnAbort\(\s*triggerWorkId, turnCtx\.state!\.nonIdempotentCallsThisTurn/);
  });

  it('SELF-TEST: the scanner sees a planted predicate and ignores a commented one', () => {
    expect(stripComments('const q = `WHERE conv_key IS NULL`;').match(PREDICATE)).toHaveLength(1);
    expect(stripComments('// WHERE conv_key IS NULL').match(PREDICATE)).toBeNull();
    expect(stripComments('  -- WHERE conv_key IS NULL').match(PREDICATE)).toBeNull();
    expect(stripComments('/* WHERE conv_key IS NULL */').match(PREDICATE)).toBeNull();
  });

  // ── PHASE-2 T10I: A SCHEMA ASSERTION, BECAUSE A SOURCE SCAN CANNOT SEE THIS ──
  // T10F's carried finding, acted on rather than repeated: two conformance tests it inherited
  // asserted "nobody writes this column" and stayed GREEN against a column that no longer
  // existed — a clause passing for a reason that had stopped being the reason. Every clause
  // above this one is a source scan and would keep passing if `148` were reverted, so the
  // column's absence is asserted against the MIGRATION CHAIN, which is strictly stronger than
  // any grep of the TypeScript.
  it('T10I: `messages.conv_key` is GONE FROM THE SCHEMA, not merely unread', () => {
    const MIG = path.join(REPO, 'packages/server/src/db/migrations');
    const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThan(140);            // non-vacuity: the chain was found

    // The drop exists, by name, and it is the LAST thing the chain says about this column.
    const dropIdx = files.findIndex((f) => f === '148_drop_messages_conv_key.sql');
    expect(dropIdx, 'migration 148 must be in the chain').toBeGreaterThan(-1);
    expect(fs.readFileSync(path.join(MIG, files[dropIdx]), 'utf8'))
      .toMatch(/ALTER TABLE messages DROP COLUMN conv_key;/);

    // ⚠ AND NOTHING AFTER IT MAY RE-ADD THE COLUMN. This is the gap T10G found the hard way:
    // a `CREATE TABLE` scan could not see migration `138` resurrecting a table via
    // `ALTER … RENAME TO`, so the check has to look for every verb that can put a column back
    // on this table — and it has to start AFTER the drop's own file, or a re-add on the very
    // next line would pass (T10F's second planted fault found exactly that off-by-one in its
    // author's own scan).
    const after = files.slice(dropIdx + 1);
    for (const f of after) {
      const sql = fs.readFileSync(path.join(MIG, f), 'utf8')
        .replace(/^\s*--[^\n]*/gm, '');                  // migration comments discuss it freely
      expect(sql, `${f} re-adds messages.conv_key after 148 dropped it`)
        .not.toMatch(/ALTER TABLE\s+["'`]?messages["'`]?\s+ADD\s+(COLUMN\s+)?["'`]?conv_key/i);
      // A rebuild-and-rename would reintroduce it just as effectively.
      if (/CREATE TABLE\s+["'`]?messages/i.test(sql) || /RENAME TO\s+["'`]?messages/i.test(sql)) {
        expect(sql, `${f} rebuilds or renames into \`messages\` — check it does not carry conv_key`)
          .not.toMatch(/\bconv_key\b/);
      }
    }
  });

  it('SELF-TEST: the walk actually reaches outside packages/', () => {
    const files = walk(path.join(REPO, 'watchdog/src'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('watchdog/src/index.ts'))).toBe(true);
  });
});
