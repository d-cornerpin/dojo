// ════════════════════════════════════════════════════════════════════════════
// v3.5 Part C — ASK THE DECISION MODEL ALONGSIDE A RULE.
//
// The one place the engine's prose judgments (inbound routing, memory shape, the provider error's class) pair a
// rule with `decide()`. A caller computes its rule exactly as it always did and hands the rule's answer here with
// the question's name (through `decision-hooks.ts`, the leaf the engine files import; this module installs itself
// into it, and the server's boot imports it):
//
//   rule    — nothing is asked (no decision model on this box, or the owner held the question to the rule);
//   shadow  — the model is asked in the BACKGROUND (it waits for the agents to go idle and never delays the
//             caller), both answers go to `decision_shadow`, and the caller gets `null`: the rule decides;
//   model   — the policy (`decision-policy.ts`) proved this question on measured accuracy: the caller gets
//             the model's verdict, unless that verdict falls in the question's weak probability band (the
//             decile where the model was right least often), where it also gets `null` = leave the rule alone.
//
// `null` means "use your rule" in every case, and it is also what any failure returns: this module never
// throws, and never calls the model itself (`decide()` is the only door). A SHADOW ask carries NO agent into
// `decide()`: an agent that is idle must not look live (a turn-scoped abortable) or be preempted because of a
// check nobody is waiting for. Only a `model`-mode ask, which the caller waits on, is the caller's own call.
//
// ONE ROW PER QUESTION PER SUBJECT: the log is keyed by the subject's own stable id (`JudgmentSpec.subject`), so
// an assemble loop, a retry or a continuation that looks at the same subject again adds no row and, in shadow,
// no request. Safety gates (the spec's Group C) never import this module nor reach it.
//
// WHAT IS NOT HERE: a truth source. `recordTruth` has no caller for these questions yet, so no question is
// ever promoted to `model` by this release on its own; the rows are the evidence the policy will read. When one
// is, the switch is recorded and told by `decision-switch.ts` (both ways).
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { decide, measuredDecideTimeoutMs, type Answer, type DecideOpts } from './decide.js';
import { modeFor } from './decision-policy.js';
import { recordShadow, scoreQuestion } from './decision-shadow.js';
import './decision-switch.js';   // installs the listener that records and tells a question's switch
import { installDecisionHooks, type Judgment, type JudgmentSpec, type Mode, type Verdict } from './decision-hooks.js';

export type { Judgment, JudgmentSpec, Verdict } from './decision-hooks.js';

const logger = createLogger('decision-ask');

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

/** The shadow log's turn id for a subject: the join key a truth writer will use. */
const turnIdFor = (purpose: string, subject: string): string => `${purpose}:${subject}`;

/** Has this subject already been judged on this question (a row exists)? */
export function alreadyJudged(purpose: string, question: string, subject: string): boolean {
  try {
    return !!getDb().prepare('SELECT 1 FROM decision_shadow WHERE turn_id = ? AND question = ? LIMIT 1').get(turnIdFor(purpose, subject), question);
  } catch { return false; }
}

/**
 * One judgment: the questions about one state, asked in ONE `decide()` call however many sites report their
 * rule. `key` memoises it (a turn's context object): the first site to report starts the call, the rest join it.
 * Each name settles once: asking it again returns the first answer and writes nothing.
 */
export function judgment(spec: JudgmentSpec, key?: object): Judgment {
  const known = key ? memo.get(key) : undefined;
  if (known) return known;
  const scored = (name: string): string => spec.questionOf?.(name) ?? name;
  const subjectOf = (name: string): string => (typeof spec.subject === 'function' ? spec.subject(name) : spec.subject);
  // The mode is resolved once per SCORED question (a batch of 200 texts is one lookup, not 200).
  const modes = new Map<string, Mode>();
  const modeOf = (name: string): Mode => {
    if (!(name in spec.questions)) return 'rule';
    const q = scored(name);
    let m = modes.get(q) ?? spec.mode;
    if (!m) { try { m = modeFor(spec.purpose, q); } catch { m = 'rule'; } }
    modes.set(q, m);
    return m;
  };
  const judged = (name: string): boolean => alreadyJudged(spec.purpose, scored(name), subjectOf(name));
  let answers: Promise<Record<string, Answer> | null> | null = null;
  const ask = (): Promise<Record<string, Answer> | null> => answers ??= (() => {
    // A subject already judged in shadow is not asked again; one the policy acts on is asked every time it is needed.
    const names = Object.keys(spec.questions).filter((n) => modeOf(n) === 'model' || (modeOf(n) === 'shadow' && !judged(n)));
    if (names.length === 0) return Promise.resolve(null);
    // Nobody waits on a shadow answer: it waits behind the agents' own turns, and `decide()` forbids it to name an agent
    // (it must not make one look live). A `model` ask is waited on: it holds the caller's stop slot from the moment it
    // queues. Either way its PATIENCE is the call's own measured timeout (`measuredDecideTimeoutMs`): no longer than the
    // call itself is allowed, counted from the ask (a waited one) or from its queue turn (a background one).
    const asking = Object.fromEntries(names.map((n) => [n, spec.questions[n]]));
    const background = !names.some((n) => modeOf(n) === 'model');
    const common = { purpose: spec.purpose, turnId: turnIdFor(spec.purpose, subjectOf(names[0])), patienceMs: measuredDecideTimeoutMs(spec.state, names.length) };
    const opts: DecideOpts = background ? { ...common, background: true } : { ...common, agentId: spec.agentId };
    return decide(spec.state, asking, opts).catch(() => null);
  })();
  const settle = (name: string, ruleSaid: unknown, modelSaid: Answer | null): void => {
    if (!modelSaid) return;   // no answer: nothing to compare (the log keeps judged rows)
    track(Promise.resolve(ruleSaid).then((rule) => {
      if (judged(name)) return;   // the subject has its row already (checked in the tick that writes it)
      recordShadow({ purpose: spec.purpose, question: scored(name), agentId: spec.agentId, turnId: turnIdFor(spec.purpose, subjectOf(name)), ruleSaid: rule, modelSaid });
    }));
  };
  const settled = new Map<string, Promise<Verdict | null>>();
  const run = (name: string, ruleSaid: unknown, strict: boolean): Promise<Verdict | null> => {
    const mode = modeOf(name);
    if (mode === 'rule') return Promise.resolve(null);
    if (mode === 'shadow') {
      if (!judged(name)) track(ask().then((all) => settle(name, ruleSaid, all?.[name] ?? null)));
      return Promise.resolve(null);
    }
    return ask().then((all) => {
      const a = all?.[name] ?? null;
      settle(name, ruleSaid, a);
      return a ? decisiveVerdict(spec.purpose, scored(name), a, strict) : null;
    }).catch(() => null);
  };
  const judgedOnce: Judgment = {
    modeOf,
    alongside(name, ruleSaid, opts) {
      try {
        let p = settled.get(name);
        if (!p) { p = run(name, ruleSaid, opts?.strict === true); settled.set(name, p); }
        return p;
      } catch { return Promise.resolve(null); }
    },
  };
  if (key) memo.set(key, judgedOnce);
  return judgedOnce;
}

installDecisionHooks({
  judgment,
  modeOf: (purpose, question) => { try { return modeFor(purpose, question); } catch { return 'rule'; } },
  judged: alreadyJudged,
});
