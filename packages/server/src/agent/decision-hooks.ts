// Leaf so no safety gate reaches decide() by import; decision-ask installs the real judgment at boot.
import type { Question } from './decide.js';

export interface Ask { agentId?: string; state: unknown; questions: Record<string, Question> }
export type Judge = (question: string, ask: Ask) => Promise<Record<string, boolean> | null>;

let installed: Judge | null = null;
export function installJudgment(judge: Judge): void { installed = judge; }

export const judgment: Judge = (question, ask) => (installed ? installed(question, ask).catch(() => null) : Promise.resolve(null));
