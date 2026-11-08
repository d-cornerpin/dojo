// The decision model's verdicts for the judgments the owner put on it (`decision-policy.ts`): one `decide()` call,
// null for every other question and on any failure, so the caller's rule answers. Installs itself into the leaf.
import { decide } from './decide.js';
import { isYes, onTheModel } from './decision-policy.js';
import { installJudgment, type Judge } from './decision-hooks.js';

export const judgment: Judge = async (question, { agentId, state, questions }) => {
  if (!onTheModel(question)) return null;
  const answers = await decide(state, questions, { purpose: question.slice(0, question.indexOf('/')), agentId }).catch(() => null);
  if (!answers) return null;
  return Object.fromEntries(Object.entries(answers).map(([name, a]) => [name, isYes(a.noul)]));
};

installJudgment(judgment);
