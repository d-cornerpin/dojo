import { describe, it, expect } from 'vitest';
import { multistepHeuristic } from '../classifiers/multistep.js';

describe('multistepHeuristic', () => {
  it('flags trivially short single questions as definitely_single', () => {
    expect(multistepHeuristic('hi').decision).toBe('definitely_single');
    expect(multistepHeuristic('what time is it').decision).toBe('definitely_single');
    expect(multistepHeuristic('thanks').decision).toBe('definitely_single');
  });

  it('flags the Plaud example as definitely_multi', () => {
    const r = multistepHeuristic(
      "I need you to pull my meetings from Plaud from this week and put together a summary " +
      "of what all happened this week, what was called out as something I was responsible for, " +
      "and anything that is upcoming that I missed. Email me the summary to my gmail.",
    );
    expect(r.decision).toBe('definitely_multi');
    expect(r.signals.actionVerbs).toBeGreaterThanOrEqual(2);
    expect(r.signals.conjunctions).toBeGreaterThanOrEqual(1);
  });

  it('flags single-action prompts without conjunctions as ambiguous or single', () => {
    const r = multistepHeuristic('summarize my emails from today');
    // One action verb, one deliverable hint — borderline. Heuristic
    // routes it to ambiguous so the LLM (or fool-proof fallback)
    // gets the call.
    expect(['ambiguous', 'definitely_single']).toContain(r.decision);
  });

  it('flags multi-verb-with-conjunction prompts as multi', () => {
    const r = multistepHeuristic('pull my unread emails and draft replies to each');
    expect(r.decision).toBe('definitely_multi');
  });

  it('treats pure-question prompts as single', () => {
    const r = multistepHeuristic('what does this codebase do');
    expect(r.decision).toBe('definitely_single');
  });

  it('counts deliverable hints', () => {
    const r = multistepHeuristic('write a summary report and email it to the team');
    expect(r.signals.deliverables).toBeGreaterThanOrEqual(1);
    expect(r.decision).toBe('definitely_multi');
  });

  it('handles tense variations of action verbs', () => {
    const r1 = multistepHeuristic('pulling meetings and summarizing them');
    const r2 = multistepHeuristic('pulled the data and summarized it');
    expect(r1.signals.actionVerbs).toBeGreaterThanOrEqual(2);
    expect(r2.signals.actionVerbs).toBeGreaterThanOrEqual(2);
  });

  it('produces a numeric score correlated with action signals', () => {
    const small = multistepHeuristic('thanks').score;
    const large = multistepHeuristic('pull data, write summary, email it, and update the tracker').score;
    expect(large).toBeGreaterThan(small);
  });
});

// ════════════════════════════════════════════════════════════════════════
// UX-REPAIR T4 — THE PRE-CALL CLASSIFIER STOPS MIS-READING BIG JOBS AS SMALL
// ONES.
//
// WHICH of the five start-ack doors opens is decided PRE-CALL by this
// heuristic on the user's own text. On 2026-08-10 it scored the LARGEST job in
// the six-scenario review `definitely_single` with `actionVerbs = 0`, so the
// pre-call door never armed and the only door left was the 30s wall-clock
// timer — whose steer cannot be spoken until the in-flight model call returns
// (observed: 50.2s). The 30s timer behaved exactly as directed and is an
// explicit owner walk-back from 12s (`64a3bcd`); it is NOT touched, and this
// task records the explicit REFUSAL to add any time-to-first-response budget.
// THE CAUSE IS THE VOCABULARY.
//
// The six verbatim prompts are pinned here as a corpus, not just S4, because
// the over-firing hazard is the real risk on this surface: research 03 measured
// 1,135 of 1,183 auto-created projects EMPTY as the failure of an eager
// classifier. S2/S5 staying `single` is as load-bearing as S4 flipping.
// ════════════════════════════════════════════════════════════════════════

// Verbatim from `.superpowers/sdd/UX-REVIEW/scenarios.md`.
const S1 = "I'm thinking about switching note-taking apps. Look into the current top options, compare them for someone who mostly writes short daily notes and needs really good search, and tell me which one you'd pick for me and why.";
const S2 = 'Make me a packing checklist for a 4-day work trip to Chicago — carry-on only, keep it practical. Put it in a file so I can open it later.';
const S3 = 'Set me a reminder every weekday at 8:30am to review my calendar. And a one-time reminder this Thursday at 3pm to call the vet.';
const S4 = "I want a comparison of HubSpot and Pipedrive for a 3-person shop. Split the research between your helpers if that's faster, and give me one combined write-up with a bottom-line recommendation.";
const S5 = "What's the biggest file in my fixtures folder? Just curious.";
const S6 = "Go through my uploads folder and give me a thorough summary of what's in there.";

describe('multistepHeuristic — the six review prompts', () => {
  it('S4 (the biggest job in the battery) reads as multi-step', () => {
    const r = multistepHeuristic(S4);
    expect(r.decision).toBe('definitely_multi');
    // The three signals the vocabulary was blind to, named individually so a
    // future narrowing says WHICH one it took away.
    expect(r.signals.actionVerbs).toBeGreaterThanOrEqual(2);
    expect(r.signals.deliverables).toBeGreaterThanOrEqual(2);
  });

  it('CONTROL: S1 stays multi (it already was)', () => {
    expect(multistepHeuristic(S1).decision).toBe('definitely_multi');
  });

  it('CONTROL: S2 and S5 stay single — the over-firing bar', () => {
    expect(multistepHeuristic(S2).decision).toBe('definitely_single');
    expect(multistepHeuristic(S5).decision).toBe('definitely_single');
  });

  it('CONTROL: S3 and S6 keep the verdicts they had', () => {
    expect(multistepHeuristic(S3).decision).toBe('ambiguous');
    expect(multistepHeuristic(S6).decision).toBe('ambiguous');
  });

  it('CONTROL: the added verbs stay verbs and the added nouns stay nouns', () => {
    // Deliverable nouns are hints, never actions — a bare noun must not become
    // an action verb, and a lookup that merely mentions one must not flip.
    expect(multistepHeuristic('what is a good comparison site').decision).toBe('definitely_single');
    expect(multistepHeuristic('thanks for the write-up').decision).toBe('definitely_single');
    expect(multistepHeuristic('any recommendation?').decision).toBe('definitely_single');
    // The nounifying guard still applies to the added verbs.
    expect(multistepHeuristic('what was the split').signals.actionVerbs).toBe(0);
    expect(multistepHeuristic('any distribute jobs today?').signals.actionVerbs).toBe(0);
  });
});
