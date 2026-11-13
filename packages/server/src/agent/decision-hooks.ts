// Leaf so no safety gate reaches decide() by import; decision-ask installs the real judgment at boot.
import type { Question } from './decide.js';

/** `combine`: one probability from several answers, judged on the question's own lines. A name between the lines is absent. */
export interface Ask { agentId?: string; state: unknown; questions: Record<string, Question>; combine?: (p: Record<string, number>) => number }
export type Judge = (question: string, ask: Ask) => Promise<Record<string, boolean> | null>;

let installed: Judge | null = null;
export function installJudgment(judge: Judge): void { installed = judge; }

export const judgment: Judge = (question, ask) => (installed ? installed(question, ask).catch(() => null) : Promise.resolve(null));
