// The leaf the engine's rule sites ask the decision model through, so no safety gate reaches `decide()` by any
// import path (`decide-never-touches-a-safety-gate.test.ts`). `decision-ask.ts` installs the real judgment (the
// server's boot imports it); until then every question is answered by its rule.
import type { Question } from './decide.js';

export interface Ask { agentId?: string; state: unknown; questions: Record<string, Question> }
/** The model's yes/no per asked name for an acting `question` (`purpose/question`), or null: the caller's rule answers. */
export type Judge = (question: string, ask: Ask) => Promise<Record<string, boolean> | null>;

let installed: Judge | null = null;
export function installJudgment(judge: Judge): void { installed = judge; }

export const judgment: Judge = (question, ask) => (installed ? installed(question, ask).catch(() => null) : Promise.resolve(null));
