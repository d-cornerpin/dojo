// v3.5 — EVERY QUESTION BEHIND THE DECISION SEAM HAS A TRUTH RULING (owner design, BACKLOG 3.5 item 29: "the Dojo
// scores them against what really happened; each question switches to the model by itself once the model is
// measurably better").
//
// The switch (`decision-policy.ts`, `decision-switch.ts`) moves a question only on judged rows, and a row is judged only
// when `recordTruth` (`decision-shadow.ts`) joins it. This census is the ruling, per question, on WHERE THAT TRUTH COMES
// FROM IN PRODUCTION: an event the engine records later that shows which answer was right. A signal is trustworthy
// only when all four hold:
//   1. it answers the question ASKED. These questions ask what a text SAYS; the ledger says whether a thing HAPPENED.
//      Scored against what happened, a claim detector is marked wrong exactly when it catches a false claim.
//   2. the rule's own answer does not cause it. In shadow the rule decides what happens next (a steer, a hint, a wake,
//      a refusal), so an outcome it causes scores the rule against itself.
//   3. it is recorded whichever way the rule and the model answered. Truth that exists on one side only promotes a
//      side by itself.
//   4. it is not a model's or an agent's own words or choice.
// Where none holds, the ruling says so and why. That question STAYS WITH ITS RULE IN PRODUCTION: it is still asked in
// shadow (owner: "both answer for a while"; its rows are what the kit reads), but nothing in production ever joins a
// truth to it, so the policy can never switch it. It is scored only OFFLINE, by the kit, against the kit's own judged
// facts (never the product's ledger) — and where the kit has no scorer yet, the ruling says that too.
//
// The census: (1) the rulings name exactly the questions the judgment modules ask; (2) the files that call
// `recordTruth` / `recordSummaryTruth` in production are exactly the declared writers of the rulings that have a
// production source (today: none); (3) each judgment module's own text points here, so its code says the same.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLY_CLAIM_PURPOSE, REPLY_CLAIM_QUESTIONS } from '../v2/reply-claims.js';
import { INBOUND_ROUTING_PURPOSE, INBOUND_ROUTING_QUESTION_NAMES } from '../v2/classifiers/inbound-routing.js';
import { MEMORY_SHAPE_PURPOSE, MEMORY_SHAPE_QUESTION_NAMES } from '../../memory/shape-judgment.js';
import { PROVIDER_ERROR_PURPOSE, PROVIDER_ERROR_QUESTION_NAMES } from '../provider-error-judgment.js';
import { SUMMARY_CHECK_PURPOSE, SUMMARY_CHECK_QUESTIONS } from '../../memory/summary-check-ledger.js';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const CENSUS = 'every-decision-question-has-a-truth-ruling';

/** A production source: the event, and the one file that records it with `recordTruth`. */
interface ProductionTruth { event: string; writer: string }
/** No trustworthy production signal: why (which of the four tests fails), and who scores it offline. */
interface NoProductionTruth { production: null; why: string; offline: string }
type Ruling = { production: ProductionTruth } | NoProductionTruth;

const KIT_D1 = 'the kit: D1 replay (dojo-test-kit behavioral/lib/decision-replay.mjs) against its authored truth table';
const NO_SCORER = 'NONE YET: the kit\'s D1 replays only the reply claims; a kit lane is owed to replay this purpose against authored truth';
const CLAIM_NOT_FACT = 'asks what the reply CLAIMS; the ledger row that would be used records whether it HAPPENED (test 1), and the floor\'s steer changes what the agent does next (test 2)';

/** THE RULINGS (orchestrator design lane, 2026-10-31). File:line evidence for each is in the lane report. */
const RULINGS: Record<string, Record<string, Ruling>> = {
  [REPLY_CLAIM_PURPOSE]: {
    declines_to_reply: { production: null, offline: KIT_D1, why: 'the only later event is the agent\'s own [no-reply] sentinel (test 4), and A1\'s rule swallows the reply when it fires (test 2)' },
    only_promises_to_start: { production: null, offline: KIT_D1, why: `a work row opened later says work began, not whether the reply ended on a bare promise; ${CLAIM_NOT_FACT}` },
    standing_promise: { production: null, offline: KIT_D1, why: `a commitment row is the agent's own act after the floor's steer (tests 2, 4); ${CLAIM_NOT_FACT}` },
    asserts_board_state: { production: null, offline: KIT_D1, why: `the board says whether the asserted state is TRUE; ${CLAIM_NOT_FACT}` },
    claims_sent_to_third_party: { production: null, offline: KIT_D1, why: `the outbound ledger and delivery receipts say whether something was sent; ${CLAIM_NOT_FACT}` },
    denies_having_sent: { production: null, offline: KIT_D1, why: `the outbound ledger says whether it was sent; ${CLAIM_NOT_FACT}` },
    claims_report_delivered: { production: null, offline: KIT_D1, why: `the report row says whether one was filed; ${CLAIM_NOT_FACT}` },
    claims_saved: { production: null, offline: KIT_D1, why: `the vault row says whether something was saved; ${CLAIM_NOT_FACT}` },
    claims_commitment_recorded: { production: null, offline: KIT_D1, why: `the commitment row says whether one was recorded; ${CLAIM_NOT_FACT}` },
  },
  [INBOUND_ROUTING_PURPOSE]: {
    simple_chat: { production: null, offline: NO_SCORER, why: 'the turn\'s later shape (no task, few tools) is the agent\'s own choice (test 4), steered by the "handle it directly" guidance the rule\'s answer injects (test 2)' },
    multi_step: { production: null, offline: NO_SCORER, why: 'the rule\'s answer sends the start ack and gates the bare [no-reply] refusal, so what follows is caused by it (test 2); what work the agent then does is its own choice (test 4)' },
    delegates: { production: null, offline: NO_SCORER, why: 'a delegate\'s result exists only if the agent delegated: its own choice (test 4), steered by the delegation hint the rule\'s answer injects (test 2)' },
    pleasantry: { production: null, offline: NO_SCORER, why: 'a pleasantry by the rule takes no turn, so nothing follows on that side (test 3); on the other side what follows is the agent\'s reply (test 4)' },
    deliverable: { production: null, offline: NO_SCORER, why: 'the rule\'s answer decides whether the primary is woken, so what the primary does next is caused by it (test 2) and is its own choice (test 4); the sender\'s tool record says something was produced, not that this message announces it ready (test 1)' },
  },
  [MEMORY_SHAPE_PURPOSE]: {
    standing_instruction: { production: null, offline: NO_SCORER, why: 'the rule\'s answer decides whether the entry is kept as written or bounced, so its later life is caused by it (test 2); who first said the words is not whether they are a standing instruction (test 1)' },
    prose_shaped: { production: null, offline: NO_SCORER, why: 'the rule\'s answer bounces the entry and the agent\'s rewrite is its own words (tests 2, 4); no later event reads the entry\'s shape' },
    obligation: { production: null, offline: NO_SCORER, why: 'an entry the rule refuses is never written, so it can never be corrected later (test 3); a later commitment row is the agent\'s own act (test 4)' },
    worth_summary: { production: null, offline: NO_SCORER, why: 'the rule\'s answer chooses a written summary or the placeholder, so every later use of that summary is caused by it (test 2)' },
    filler: { production: null, offline: NO_SCORER, why: 'the one later reader is the Dreamer, an agent (test 4), and the rule hides what it calls filler from it (test 3)' },
  },
  [PROVIDER_ERROR_PURPOSE]: {
    error_class: { production: null, offline: NO_SCORER, why: 'the rule\'s class picks the recovery (retry, lock, banner), so whether the request is ever sent again is caused by it (test 2); and a later success cannot tell "briefly unavailable" from "rate limited", so it names none of the five answers (test 1)' },
  },
  [SUMMARY_CHECK_PURPOSE]: {
    invented: { production: null, offline: NO_SCORER, why: 'whether a summary says something its source does not is a reading of two texts; nothing in the engine records such a reading later (no one reviews summaries), so there is no event (test 1)' },
    dropped: { production: null, offline: NO_SCORER, why: 'whether a summary left out a request, decision, instruction or name is a reading of two texts; no later event records it (test 1)' },
    stated_current: { production: null, offline: NO_SCORER, why: 'whether a summary describes something as still pending is a reading of its text; the ledger\'s open work says what IS pending, not what the summary says (test 1)' },
  },
};

/** What each judgment module asks, from the module itself. */
const ASKED: Record<string, readonly string[]> = {
  [REPLY_CLAIM_PURPOSE]: Object.keys(REPLY_CLAIM_QUESTIONS),
  [INBOUND_ROUTING_PURPOSE]: INBOUND_ROUTING_QUESTION_NAMES,
  [MEMORY_SHAPE_PURPOSE]: MEMORY_SHAPE_QUESTION_NAMES,
  [PROVIDER_ERROR_PURPOSE]: PROVIDER_ERROR_QUESTION_NAMES,
  [SUMMARY_CHECK_PURPOSE]: SUMMARY_CHECK_QUESTIONS,
};
/** The module that asks each purpose (its text must point here). */
const MODULES: Record<string, string> = {
  [REPLY_CLAIM_PURPOSE]: 'agent/v2/reply-claims.ts',
  [INBOUND_ROUTING_PURPOSE]: 'agent/v2/classifiers/inbound-routing.ts',
  [MEMORY_SHAPE_PURPOSE]: 'memory/shape-judgment.ts',
  [PROVIDER_ERROR_PURPOSE]: 'agent/provider-error-judgment.ts',
  [SUMMARY_CHECK_PURPOSE]: 'memory/summary-check-ledger.ts',
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}
/** Does this source CALL a truth intake (a definition is not a call)? Comments are ignored. */
function callsTruthIntake(text: string): boolean {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return /\b(recordTruth|recordSummaryTruth)\s*\(/.test(code.replace(/\bexport\s+function\s+recordTruth\s*\(/g, ''));
}
/** The intakes, not sources: the shadow log defines `recordTruth`; the summary ledger only re-keys a summary's id into it. */
const INTAKES = new Set(['agent/decision-shadow.ts', 'memory/summary-check-ledger.ts']);

describe('the rulings cover exactly the questions behind the seam', () => {
  for (const [purpose, asked] of Object.entries(ASKED)) {
    it(`${purpose}: every question it asks has a ruling, and every ruling is a question it asks`, () => {
      expect(asked.length).toBeGreaterThan(0);
      expect(Object.keys(RULINGS[purpose] ?? {}).sort()).toEqual([...asked].sort());
    });
  }
  it('no ruling for a purpose nobody asks', () => {
    expect(Object.keys(RULINGS).sort()).toEqual(Object.keys(ASKED).sort());
  });
  it('a question with no production source says why and who scores it offline', () => {
    for (const [purpose, qs] of Object.entries(RULINGS)) {
      for (const [q, r] of Object.entries(qs)) {
        if ('production' in r && r.production === null) {
          expect(r.why.length, `${purpose}/${q}`).toBeGreaterThan(0);
          expect(r.offline.length, `${purpose}/${q}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('truth is written in production only by a declared source', () => {
  const declared = new Set(Object.values(RULINGS).flatMap((qs) => Object.values(qs))
    .flatMap((r) => (r.production ? [r.production.writer] : [])));
  it('the files that call recordTruth / recordSummaryTruth are exactly the declared writers (today: none)', () => {
    const callers = sourceFiles(SRC).map((f) => path.relative(SRC, f)).filter((f) => !INTAKES.has(f) && callsTruthIntake(fs.readFileSync(path.join(SRC, f), 'utf8')));
    expect(callers.sort()).toEqual([...declared].sort());
  });
  it('every declared writer is a real file', () => {
    for (const w of declared) expect(fs.existsSync(path.join(SRC, w)), w).toBe(true);
  });
  it('the scan is not blind: a planted call is found, a definition, a comment and a mention are not', () => {
    expect(callsTruthIntake("recordTruth(turnId, 'claims_saved', true, 'vault_entries');")).toBe(true);
    expect(callsTruthIntake("  void recordSummaryTruth (id, 'dropped', false, 'x');")).toBe(true);
    expect(callsTruthIntake('export function recordTruth(turnId: string): void {}')).toBe(false);
    expect(callsTruthIntake('// recordTruth(turnId, q) has no caller')).toBe(false);
    expect(callsTruthIntake('/** `recordTruth` joins it */')).toBe(false);
  });
  it('the intakes are what they claim: the shadow log defines recordTruth; the ledger only re-keys it', () => {
    expect(fs.readFileSync(path.join(SRC, 'agent/decision-shadow.ts'), 'utf8')).toMatch(/export function recordTruth\(/);
    const ledger = fs.readFileSync(path.join(SRC, 'memory/summary-check-ledger.ts'), 'utf8');
    expect(ledger.match(/\brecordTruth\(/g)).toHaveLength(1);
    expect(ledger).toMatch(/export const recordSummaryTruth = [^\n]*=>\s*\n\s*recordTruth\(summaryCheckIdOfRow\(summaryId\), question, truth, src\);/);
  });
});

describe('each judgment module says the same in its own text', () => {
  for (const [purpose, file] of Object.entries(MODULES)) {
    it(`${file} points at this census`, () => {
      expect(fs.readFileSync(path.join(SRC, file), 'utf8'), purpose).toContain(CENSUS);
    });
  }
  it('the shadow log\'s intake points here too', () => {
    expect(fs.readFileSync(path.join(SRC, 'agent/decision-shadow.ts'), 'utf8')).toContain(CENSUS);
  });
});
