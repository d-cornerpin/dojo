// ════════════════════════════════════════════════════════════════════════════════════════
// THE ESTIMATE SPENDS WHAT THE BOX MEASURED — BACKLOG line 56, and line 36's deferred half.
//
// ── THE DEFECT, AND THE CORRECTION TO THE LINE THAT REPORTS IT ──
// BACKLOG line 56, verbatim: "estimator_chars_per_token pinned at 4.0 but provider-reported
// totals run 1.88-2.08x the estimate on dense prompts — any budget keyed on
// estimated_input_tokens (incl. the v3.1.27 unattended budget) undercounts real billing by
// ~half."
//
// ⚠ THE PARENTHETICAL IS WRONG AT THIS HEAD, re-derived per G11 before any of this was built.
// `agent/unattended-budget.ts` is a budget in MINUTES and contains ZERO token references, so it
// is not keyed on this estimate and cannot undercount from it. §THE PREMISE below holds that
// correction as a clause, so the next reader meets the measurement instead of the claim. The
// real consumers keyed on the estimate are both in `agent/model.ts`:
//
//   `refuseIfDoomed`      — the pre-dial fit gate. Compares the estimate against what the
//                           provider's prefill throughput covers inside its first-chunk
//                           patience. Halve the estimate and the gate waves through a request
//                           that will take twice as long to prefill as it believes, and the turn
//                           dies at the first-chunk watchdog — the exact outcome the gate exists
//                           to buy out, bought and then lost to arithmetic.
//   `resolveOutputBudget` — grants output room from `contextWindow - inputEstimate`. The same
//                           error over-grants, which is how a request exceeds a window the
//                           allocator believed it had planned.
//
// ── WHAT IS ASSERTED ──
//   §THE PREMISE          the two measured populations, and the unattended-budget correction
//   §THE DENSE FIXTURE    a schema-dominated request, measured BOTH WAYS (unmeasured box vs
//                         measured box) against the provider-reported truth
//   §THE CONSERVATIVE FLOOR  the estimate can only GROW; neither bound may be removed
//   §THE POPULATIONS      prose is not estimated with the dense divisor, which is the whole
//                         point of migration 181's split
//   §THE LEDGER CONTRACT  `chars = estimate x effectiveCharsPerToken` stays exact, so the
//                         self-calibration loop measures the tokeniser and not itself
//   §THE WIRING           both dial sites really spend it — both ways (G4)
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHARS_PER_TOKEN,
  estimateTokens,
  estimateTokensFromChars,
  estimateRequestTokens,
  effectiveDivisor,
  type MeasuredDivisors,
} from '../budget.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const SERVER_SRC = path.join(REPO_ROOT, 'packages/server/src');
const read = (rel: string): string => fs.readFileSync(path.join(SERVER_SRC, rel), 'utf-8');
/** Comments stripped (G4): a clause satisfiable by the prose above a call tests the comment. */
const code = (rel: string): string => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');

/** The two populations as this tree measured them. See the migration-181 header. */
const PROSE_TRUTH = 4.08;    // budget.ts's derivation: /4 ran 2% UNDER the real cost
const DENSE_TRUTH = 4 / 2.0; // BACKLOG 56: the estimate ran 1.88-2.08x UNDER → ~2.0 chars/token

const UNMEASURED: MeasuredDivisors = { prose: null, dense: null };
/** A box that has measured itself: both readings established from its own ledger. */
const MEASURED: MeasuredDivisors = { prose: PROSE_TRUTH, dense: DENSE_TRUTH };

/**
 * THE DENSE FIXTURE — the request shape BACKLOG line 56 was measured on: a ~72 KB tools array
 * dominating a few thousand characters of prose. Sizes are the ones the tree records for a real
 * turn (the always-loaded surface is ~72 KB; the owner's measured turns run 42-52K tokens).
 */
const DENSE_FIXTURE = { proseChars: 60_000, schemaChars: 72_000 };
/** What the provider REALLY bills for that fixture, from the two population truths. */
const DENSE_FIXTURE_BILLED = Math.round(
  DENSE_FIXTURE.proseChars / PROSE_TRUTH + DENSE_FIXTURE.schemaChars / DENSE_TRUTH,
);

describe('§THE PREMISE — the numbers, and a correction to the line that reports them', () => {
  it('the estimator is still asserted at 4 for the stored-row dialect', () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });

  it('the dense population really is ~2x denser than prose, which is why one constant cannot serve', () => {
    expect(PROSE_TRUTH / DENSE_TRUTH).toBeGreaterThan(1.5);
  });

  it('⚠ CORRECTION: the unattended budget is NOT keyed on this estimate — it is a MINUTES budget', () => {
    // BACKLOG 56 names it as a victim. It is not one, and a reader who inherits that claim will
    // go looking for a token path that does not exist. Measured, not argued:
    const src = read('agent/unattended-budget.ts');
    expect(
      /token/i.test(src),
      'agent/unattended-budget.ts now mentions tokens. If the unattended budget has genuinely '
      + 'become keyed on an estimate, BACKLOG line 56\'s parenthetical stops being wrong and THIS '
      + 'clause is where that is noticed rather than assumed.',
    ).toBe(false);
  });

  it('the two real consumers of the estimate are the fit gate and the output budget', () => {
    const model = code('agent/model.ts');
    expect(model, 'the pre-dial fit gate no longer reads an estimate').toMatch(
      /refuseIfDoomed\(\s*agentId,\s*(finalInputEstimate|inputEstimate)/);
    expect(model, 'the output budget no longer reads an estimate').toMatch(
      /resolveOutputBudget\(modelInfo,\s*finalInputEstimate\)/);
  });
});

describe('§THE DENSE FIXTURE — measured both ways', () => {
  it('RED-CRITICAL: on a MEASURED box the estimate no longer undercounts real billing by ~half', () => {
    const measured = estimateRequestTokens(DENSE_FIXTURE, MEASURED);
    const ratio = DENSE_FIXTURE_BILLED / measured.tokens;
    expect(
      ratio,
      `the dense fixture is really billed ${DENSE_FIXTURE_BILLED} tokens and the estimate says `
      + `${measured.tokens} — a factor of ${ratio.toFixed(2)}. BACKLOG line 56 reports 1.88-2.08x, `
      + 'and the whole point of spending the measured divisor is that this factor comes to 1. The '
      + 'pre-dial fit gate and the output budget both plan against this number.',
    ).toBeCloseTo(1.0, 1);
  });

  it('CONTROL — on an UNMEASURED box it still undercounts, exactly as reported', () => {
    // The other direction of the same measurement, which is what makes the clause above a
    // measurement rather than a tautology: the defect is reproduced here, at the reported size.
    const today = estimateRequestTokens(DENSE_FIXTURE, UNMEASURED);
    const ratio = DENSE_FIXTURE_BILLED / today.tokens;
    expect(ratio, 'the reported undercount is no longer reproducible, so the fixture has drifted '
      + 'away from the shape BACKLOG 56 was measured on').toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2.2);
  });

  it('an UNMEASURED box gets today\'s number byte for byte — nothing changes until it measures', () => {
    const today = estimateRequestTokens(DENSE_FIXTURE, UNMEASURED);
    expect(today.tokens).toBe(
      estimateTokensFromChars(DENSE_FIXTURE.proseChars + DENSE_FIXTURE.schemaChars));
    expect(today.effectiveCharsPerToken).toBeCloseTo(CHARS_PER_TOKEN, 3);
  });
});

describe('§THE CONSERVATIVE FLOOR — the estimate can only grow', () => {
  it('RED-CRITICAL: a measured divisor LARGER than the constant cannot shrink the estimate', () => {
    // A box whose prose really tokenises at 6 chars/token would, unfloored, estimate 1/3 less
    // than today — and every decision this feeds would become LESS cautious than before the
    // measurement existed. That is the one direction a measurement must never move a budget.
    const generous = estimateRequestTokens(DENSE_FIXTURE, { prose: 6, dense: 9 });
    const today = estimateRequestTokens(DENSE_FIXTURE, UNMEASURED);
    expect(
      generous.tokens,
      'a generous measurement shrank the estimate below the asserted constant\'s answer. The fit '
      + 'gate then refuses later and the output budget grants more, both on the strength of a '
      + 'number nobody declared — migration 174\'s "an over-measured box is a cautious box", '
      + 'inverted.',
    ).toBe(today.tokens);
  });

  it('bound A: each divisor is capped at the constant', () => {
    expect(effectiveDivisor(2.0)).toBeCloseTo(2.0, 6);
    expect(effectiveDivisor(6.0)).toBe(CHARS_PER_TOKEN);
    expect(effectiveDivisor(CHARS_PER_TOKEN)).toBe(CHARS_PER_TOKEN);
  });

  it('bound A: a reading that is not a positive finite number is not spent', () => {
    for (const bad of [null, undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveDivisor(bad as number | null | undefined), `spent ${String(bad)}`)
        .toBe(CHARS_PER_TOKEN);
    }
  });

  it('a smaller divisor always means an estimate at least as large — monotone, no exceptions', () => {
    let previous = 0;
    for (const prose of [4, 3.5, 3, 2.5, 2, 1.5, 1]) {
      const t = estimateRequestTokens(DENSE_FIXTURE, { prose, dense: DENSE_TRUTH }).tokens;
      expect(t).toBeGreaterThanOrEqual(previous);
      previous = t;
    }
  });

  it('zero characters is zero tokens, and reports the constant rather than 0/0', () => {
    const e = estimateRequestTokens({ proseChars: 0, schemaChars: 0 }, MEASURED);
    expect(e.tokens).toBe(0);
    expect(e.effectiveCharsPerToken).toBe(CHARS_PER_TOKEN);
  });

  it('negative characters cannot produce a negative estimate', () => {
    expect(estimateRequestTokens({ proseChars: -100, schemaChars: -5 }, MEASURED).tokens).toBe(0);
  });
});

describe('§THE POPULATIONS — prose is not estimated with the dense divisor', () => {
  it('RED-CRITICAL: a PROSE-ONLY request is estimated at the prose reading, not the dense one', () => {
    const prose = { proseChars: 80_000, schemaChars: 0 };
    const correct = estimateRequestTokens(prose, MEASURED).tokens;
    const singleMinimum = estimateRequestTokens(prose, { prose: DENSE_TRUTH, dense: DENSE_TRUTH }).tokens;
    expect(
      correct,
      'a prose request was estimated with the dense divisor. That is the single-minimum answer '
      + 'BACKLOG line 36 asked about, and it inflates the dominant population ~2.1x — worse than '
      + 'the 30% over-estimate budget.ts\'s own derivation header refused at /3.',
    ).toBeLessThan(singleMinimum);
    expect(singleMinimum / correct).toBeGreaterThan(1.9);
    // AND IT IS EXACTLY TODAY'S ANSWER, which is the two bounds interacting and is worth saying
    // out loud: this tree's measured prose ratio (4.08) is ABOVE the asserted 4, so bound A caps
    // it at 4 and the prose reading is INERT here. The split's value on such a box is therefore
    // not a better prose number — it is that prose is NOT DRAGGED DOWN to the dense minimum. The
    // next clause covers the box where the prose reading does bite.
    expect(correct).toBe(estimateTokensFromChars(prose.proseChars));
  });

  it('where prose measures BELOW the constant, the prose reading is spent and stays its own', () => {
    // A tokeniser denser than 4 chars/token on prose is ordinary (non-English text, code-heavy
    // prose). Then both readings bite, and they must bite separately.
    const prose = { proseChars: 80_000, schemaChars: 0 };
    const dense = { proseChars: 0, schemaChars: 80_000 };
    const readings: MeasuredDivisors = { prose: 3.2, dense: 2.0 };
    expect(estimateRequestTokens(prose, readings).tokens).toBe(Math.ceil(80_000 / 3.2));
    expect(estimateRequestTokens(dense, readings).tokens).toBe(Math.ceil(80_000 / 2.0));
    expect(
      estimateRequestTokens(prose, readings).tokens,
      'the prose request was estimated at the dense reading — the populations have collapsed back '
      + 'into one, which is the single minimum this split exists to refuse.',
    ).toBeLessThan(estimateRequestTokens(dense, readings).tokens);
  });

  it('a SCHEMA-ONLY request is estimated at the dense reading', () => {
    const schema = { proseChars: 0, schemaChars: 72_000 };
    expect(estimateRequestTokens(schema, MEASURED).tokens)
      .toBe(Math.ceil(72_000 / DENSE_TRUTH));
  });

  it('one measured population and one unmeasured: the unmeasured half falls back, alone', () => {
    const mixed = estimateRequestTokens(DENSE_FIXTURE, { prose: null, dense: DENSE_TRUTH });
    expect(mixed.tokens).toBe(
      estimateTokensFromChars(DENSE_FIXTURE.proseChars) + Math.ceil(DENSE_FIXTURE.schemaChars / DENSE_TRUTH));
  });
});

describe('§THE LEDGER CONTRACT — the loop measures the tokeniser, not itself', () => {
  it('RED-CRITICAL: `chars = estimate x effectiveCharsPerToken` recovers the character count', () => {
    for (const fixture of [
      DENSE_FIXTURE,
      { proseChars: 80_000, schemaChars: 0 },
      { proseChars: 0, schemaChars: 72_000 },
      { proseChars: 3, schemaChars: 7 },
    ]) {
      const total = fixture.proseChars + fixture.schemaChars;
      const e = estimateRequestTokens(fixture, MEASURED);
      expect(
        e.tokens * e.effectiveCharsPerToken,
        'the recorded divisor does not invert the estimate. `costs/ledger-calibration.ts` divides '
        + 'this product by the BILLED tokens to get the row\'s true ratio, so a product that is not '
        + 'the real character count makes every future reading a measurement of our own arithmetic '
        + 'error instead of the provider\'s tokeniser — a loop feeding on itself.',
      ).toBeCloseTo(total, 6);
    }
  });

  it('the effective divisor sits between the two it blends', () => {
    const e = estimateRequestTokens(DENSE_FIXTURE, MEASURED);
    expect(e.effectiveCharsPerToken).toBeGreaterThan(DENSE_TRUTH * 0.9);
    expect(e.effectiveCharsPerToken).toBeLessThanOrEqual(CHARS_PER_TOKEN);
  });
});

describe('§THE WIRING — ALL FOUR dial sites really spend it (G4, both ways)', () => {
  // ⚠ IT WAS TWO, AND t113 D MADE IT FOUR. t108 wired the two transports whose estimate it
  // owned and its own review recorded the residual: the `agent-sdk` and `ollama` transports
  // have their own pre-dial fit gates, and both were still spending the raw `/4` constant
  // (BACKLOG line 101). No regression — they always did — but the same undercount class on two
  // side doors, so on a provider whose own ledger says its dense prompts run nearer 2
  // chars/token those two gates decided against roughly half the real size.
  //
  // The count pin MOVED rather than being deleted, deliberately: it is the thing that notices a
  // fifth transport arriving without a gate, or one of these four quietly dropping back to the
  // constant.
  const DIAL_SITES = 4;

  it('every dial site that produces an estimate produces it through `estimateRequestTokens`', () => {
    const model = code('agent/model.ts');
    const calls = [...model.matchAll(/estimateRequestTokens\(/g)].length;
    expect(calls, 'a dial site stopped spending the measured divisor').toBe(DIAL_SITES);
    // The APPLICATION, not the presence: each must be seeded with the provider's own readings.
    expect([...model.matchAll(/measuredDivisorsFor\(modelInfo\.providerId\)/g)].length)
      .toBe(DIAL_SITES);
  });

  it('no site re-sums `estimateTokens` into an input estimate behind the new door', () => {
    // The both-ways direction: the old arithmetic coming back ALONGSIDE the new door would leave
    // the clauses above green while the wire still undercounted. All four estimates are named
    // here, so a site reverting to a raw sum reds by name.
    const model = code('agent/model.ts');
    for (const name of ['finalInputEstimate', 'inputEstimate', 'nativeEstimate', 'sdkInputEstimate']) {
      const assignment = new RegExp(`const ${name}\\s*=\\s*([\\s\\S]*?);\\n`).exec(model)?.[1] ?? '';
      expect(assignment, `${name} was not found, or is still assembled from raw estimateTokens() sums`)
        .not.toMatch(/estimateTokens\(/);
      expect(assignment, `${name} is no longer the measured-divisor estimate`)
        .toMatch(/estimateRequestTokens\(|Estimate\.tokens/);
    }
  });

  it('the two side doors split PROSE from SCHEMA, which is the whole reason for two divisors', () => {
    // A site that passed the whole request as `proseChars` would spend the prose divisor on a
    // dense tools array — green on the clauses above, and wrong. So the split is asserted at
    // each new site, with the tools array on the schema side where it belongs.
    const model = code('agent/model.ts');
    expect(model, 'the ollama gate puts its tools array on the schema side')
      .toMatch(/proseChars: JSON\.stringify\(nativeMessages\)\.length,\s*schemaChars: JSON\.stringify\(nativeTools \?\? \[\]\)\.length,/);
    expect(model, 'the agent-sdk gate counts system prompt + messages as prose, toolDefs as schema')
      .toMatch(/proseChars: systemPrompt\.length \+ JSON\.stringify\(messages\)\.length,\s*schemaChars: JSON\.stringify\(toolDefs\)\.length,/);
  });

  it('and on an UNMEASURED provider both side doors return today\'s number, byte for byte', () => {
    // The no-behaviour-change half the line asks for explicitly, asserted as ARITHMETIC rather
    // than as a promise: with no reading, both of `estimateRequestTokens`'s bounds collapse to
    // `/CHARS_PER_TOKEN` over the same total characters, so the new call equals the old sum.
    const prose = 'a prose system prompt and its messages, of some length'.repeat(37);
    const schema = JSON.stringify([{ name: 'a_tool', input_schema: { type: 'object' } }]);
    const wasOllama = estimateTokens(prose) + estimateTokens(schema);
    const nowOllama = estimateRequestTokens(
      { proseChars: prose.length, schemaChars: schema.length }, { prose: null, dense: null },
    ).tokens;
    // ⚠ The two forms differ by at most the per-term `Math.ceil` the old sum paid TWICE and the
    // new floor pays ONCE over the total — never by more, and never downward. Stated as the
    // bound it is rather than as an equality that would be a coincidence.
    expect(nowOllama).toBeLessThanOrEqual(wasOllama);
    expect(nowOllama).toBeGreaterThanOrEqual(wasOllama - 1);
    // and the direction that matters: a MEASURED provider can only make it bigger
    const measured = estimateRequestTokens(
      { proseChars: prose.length, schemaChars: schema.length }, { prose: 2, dense: 2 },
    ).tokens;
    expect(measured, 'a denser box estimates more, never less').toBeGreaterThan(nowOllama);
  });

  it('the effective divisor reaches the ledger from both sites', () => {
    const model = code('agent/model.ts');
    expect([...model.matchAll(/estimatorCharsPerToken:\s*\w+Estimate\.effectiveCharsPerToken/g)].length,
      'a site records an estimate without the divisor that produced it').toBe(2);
    const tracker = code('costs/tracker.ts');
    expect(tracker, 'the writer ignores the supplied divisor and stores the constant regardless')
      .toMatch(/estimatorCharsPerToken[\s\S]{0,400}CHARS_PER_TOKEN/);
  });

  it('`memory/budget.ts` is still a LEAF — the arithmetic stayed pure', () => {
    // Its own header: taking a modelId (and therefore a database) would make the budget cyclic
    // with its own consumers. The DB read lives in `costs/estimator-divisors.ts` instead.
    const imports = [...read('memory/budget.ts').matchAll(/^import .*from '([^']+)'/gm)].map(m => m[1]);
    for (const i of imports) {
      expect(i, `memory/budget.ts imports ${i}; the estimator must not reach a connection`)
        .not.toMatch(/db\/connection|costs\//);
    }
  });
});
