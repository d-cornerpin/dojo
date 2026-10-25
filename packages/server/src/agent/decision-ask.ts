// ════════════════════════════════════════════════════════════════════════════
// v3.5 Part C — ASK THE DECISION MODEL ALONGSIDE A RULE.
//
// The one place the engine's prose judgments (inbound routing, memory shape, the provider error's class)
// pair a rule with `decide()`. A caller computes its rule exactly as it always did and hands the rule's
// answer here with the question's name:
//
//   rule    — nothing is asked (no decision model on this box, or the owner held the question to the rule);
//   shadow  — the model is asked in the BACKGROUND (it waits for the agents to go idle and never delays the
//             caller), both answers go to `decision_shadow`, and the caller gets `null`: the rule decides;
//   model   — the policy (`decision-policy.ts`) proved this question on measured accuracy: the caller gets
//             the model's verdict, unless that verdict falls in the question's weak probability band (the
//             decile where the model was right least often), where it also gets `null` = leave the rule alone.
//
// `null` means "use your rule" in every case, and it is also what any failure returns: this module never
// throws, and never calls the model itself (`decide()` is the only door). Safety gates (the spec's Group C)
// never import it: `agent/__tests__/decide-never-touches-a-safety-gate.test.ts` pins that.
//
// WHAT IS NOT HERE: a truth source. `recordTruth` has no caller for these questions yet, so no question is
// ever promoted to `model` by this release on its own; the rows are the evidence the policy will read.
// ════════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import { decide, type Answer, type Question } from './decide.js';
import { modeFor, type Mode } from './decision-policy.js';
import { recordShadow, scoreQuestion } from './decision-shadow.js';

const logger = createLogger('decision-ask');

/** What the model decided, in the rule's own terms: a yes/no for a `noul`, the chosen name for a `choice`. */
export type Verdict = boolean | string;

export interface JudgmentSpec {
  /** The decision-model purpose (cost rows, the shadow log, the owner's `decision_mode.<purpose>.<question>`). */
  purpose: string;
  agentId?: string;
  turnId?: string;
  /** The material the questions are about; every text in it is fenced by `decide()`. */
  state: unknown;
  questions: Record<string, Question>;
}

export interface Judgment {
  modeOf(name: string): Mode;
  /**
   * The rule's answer for `name` is known (or will be: a promise is awaited off the caller's path): log both
   * and, in `model` mode, return the model's verdict when it is outside the question's weak band.
   * Otherwise resolves `null` at once. `strict` also leaves alone any verdict not clearly beyond the band
   * (for the questions where acting wakes an agent or locks one).
   */
  alongside(name: string, ruleSaid: unknown, opts?: { strict?: boolean }): Promise<Verdict | null>;
}

const decile = (p: number): number => Math.min(9, Math.max(0, Math.floor(p * 10)));

/** The model's answer as a verdict and the probability the score reads it at (`decision-shadow.ts verdictOf`). */
function readAnswer(a: Answer): { said: Verdict; p: number } | null {
  if (a.type === 'noul') return { said: a.noul >= 0.5, p: a.noul };
  if (a.type === 'choice') return { said: a.choice, p: a.confidence };
  return null;   // a `score` has no yes/no for a rule to be replaced by
}

/** The verdict to act on, or null when it sits in the weak band (or no score exists to say where the band is). */
export function decisiveVerdict(purpose: string, name: string, a: Answer, strict = false): Verdict | null {
  const score = scoreQuestion(purpose, name);
  const v = readAnswer(a);
  if (!score || !v) return null;
  const [lo, hi] = score.band;
  if (decile(v.p) === Math.round(lo * 10)) return null;
  if (strict) {
    // Strictest: beyond the band, and for a yes/no clearly beyond it on the far side of 0.5 as well.
    if (a.type === 'noul' ? Math.abs(v.p - 0.5) <= Math.max(Math.abs(lo - 0.5), Math.abs(hi - 0.5)) : v.p <= hi) return null;
  }
  return v.said;
}

const memo = new WeakMap<object, Judgment>();
const inFlight = new Set<Promise<unknown>>();
/** Resolves when every shadow ask started so far has recorded its rows. Starts nothing. */
export async function decisionAsksSettled(): Promise<void> { while (inFlight.size > 0) await Promise.all([...inFlight]); }
function track(p: Promise<unknown>): void {
  const done = p.catch((err) => logger.warn('a decision ask failed; the rule decided', { error: err instanceof Error ? err.message : String(err) }))
    .finally(() => { inFlight.delete(done); });
  inFlight.add(done);
}

/**
 * One judgment: the questions about one state, asked in ONE `decide()` call however many sites report their
 * rule. `key` memoises it (a turn's context object): the first site to report starts the call, the rest join it.
 */
export function judgment(spec: JudgmentSpec, key?: object): Judgment {
  const known = key ? memo.get(key) : undefined;
  if (known) return known;
  const turnId = spec.turnId ?? randomUUID();
  const modes = new Map<string, Mode>();
  const modeOf = (name: string): Mode => {
    let m = modes.get(name);
    if (!m) {
      try { m = name in spec.questions ? modeFor(spec.purpose, name) : 'rule'; } catch { m = 'rule'; }
      modes.set(name, m);
    }
    return m;
  };
  let answers: Promise<Record<string, Answer> | null> | null = null;
  const ask = (): Promise<Record<string, Answer> | null> => answers ??= (() => {
    const names = Object.keys(spec.questions).filter((n) => modeOf(n) !== 'rule');
    if (names.length === 0) return Promise.resolve(null);
    // Nobody waits on a shadow answer: it waits behind the agents' own turns. A `model` question is waited on.
    const background = !names.some((n) => modeOf(n) === 'model');
    return decide(spec.state, Object.fromEntries(names.map((n) => [n, spec.questions[n]])), {
      purpose: spec.purpose, agentId: spec.agentId, turnId, background,
    }).catch(() => null);
  })();
  const settle = (name: string, ruleSaid: unknown, modelSaid: Answer | null): void => {
    if (!modelSaid) return;   // no answer: nothing to compare (the log keeps judged rows)
    track(Promise.resolve(ruleSaid).then((rule) => {
      recordShadow({ purpose: spec.purpose, question: name, agentId: spec.agentId, turnId, ruleSaid: rule, modelSaid });
    }));
  };
  const judged: Judgment = {
    modeOf,
    alongside(name, ruleSaid, opts) {
      try {
        const mode = modeOf(name);
        if (mode === 'rule') return Promise.resolve(null);
        if (mode === 'shadow') {
          track(ask().then((all) => settle(name, ruleSaid, all?.[name] ?? null)));
          return Promise.resolve(null);
        }
        return ask().then((all) => {
          const a = all?.[name] ?? null;
          settle(name, ruleSaid, a);
          return a ? decisiveVerdict(spec.purpose, name, a, opts?.strict === true) : null;
        }).catch(() => null);
      } catch { return Promise.resolve(null); }
    },
  };
  if (key) memo.set(key, judged);
  return judged;
}
