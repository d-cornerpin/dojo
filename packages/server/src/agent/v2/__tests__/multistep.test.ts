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
