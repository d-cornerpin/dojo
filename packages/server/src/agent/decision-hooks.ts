// ════════════════════════════════════════════════════════════════════════════
// v3.5 C2/C3 — THE LEAF THE ENGINE'S RULES ASK THROUGH. Imports nothing of the engine.
//
// The modules that pair a rule with the decision model (inbound routing, memory shape, the provider error's class)
// sit inside engine files that safety gates import for other reasons (spawner, runtime, the bridge). If they
// imported `decide()` themselves, every gate would reach the decision code by some import path. So they import THIS
// leaf, which holds the seam's typed surface and a registry: until `decision-ask.ts` installs itself (the server's
// boot imports it; a unit test that wants the real thing imports it), every question is held to its rule — `null`
// from `alongside`, mode `rule`, nothing asked.
//
// `agent/__tests__/decide-never-touches-a-safety-gate.test.ts` walks the import graph from every gate file and
// requires that none reaches `decide` or `decision-ask`; this leaf is why the engine files in between do not.
// ════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { Question } from './decide.js';

export type Mode = 'rule' | 'shadow' | 'model';
/** What the model decided, in the rule's own terms: a yes/no for a `noul`, the chosen name for a `choice`. */
export type Verdict = boolean | string;

export interface JudgmentSpec {
  /** The decision-model purpose (cost rows, the shadow log, the owner's `decision_mode.<purpose>.<question>`). */
  purpose: string;
  agentId?: string;
  /** THE SUBJECT: the stable id of the thing judged (the trigger message, the inbound message, the vault entry's text, the summary).
   *  The shadow log is keyed by it: one row per question per subject, however many times it is looked at. A function
   *  names the subject per question key (a batch of many texts asked in one request). */
  subject: string | ((name: string) => string);
  /** The material the questions are about; every text in it is fenced by `decide()`. */
  state: unknown;
  questions: Record<string, Question>;
  /** When one question is asked many times over (a batch of messages), the name it is scored under. */
  questionOf?: (name: string) => string;
  /** A mode the caller already resolved once for the whole batch. */
  mode?: Mode;
}

export interface Judgment {
  modeOf(name: string): Mode;
  /**
   * The rule's answer for `name` is known (or will be: a promise is awaited off the caller's path): log both
   * and, in `model` mode, return the model's verdict when it is outside the question's weak band. Otherwise
   * resolves `null` at once. `strict` also leaves alone any verdict not clearly beyond the band.
   */
  alongside(name: string, ruleSaid: unknown, opts?: { strict?: boolean }): Promise<Verdict | null>;
}

export interface DecisionHooks {
  judgment(spec: JudgmentSpec, key?: object): Judgment;
  modeOf(purpose: string, question: string): Mode;
  /** Has the shadow log already judged this subject on this question? */
  judged(purpose: string, question: string, subject: string): boolean;
}

const RULE_ONLY: Judgment = { modeOf: () => 'rule', alongside: () => Promise.resolve(null) };
let installed: DecisionHooks | null = null;
export function installDecisionHooks(h: DecisionHooks): void { installed = h; }

export const judgment = (spec: JudgmentSpec, key?: object): Judgment => installed?.judgment(spec, key) ?? RULE_ONLY;
export const modeOf = (purpose: string, question: string): Mode => installed?.modeOf(purpose, question) ?? 'rule';
export const judged = (purpose: string, question: string, subject: string): boolean => installed?.judged(purpose, question, subject) ?? false;

/** A stable subject id for a thing that has none of its own: the same parts always make the same id. */
export function subjectKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}
