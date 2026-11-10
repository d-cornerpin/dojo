// One decide() call for the owner's on-the-model questions; null otherwise means the rule answers.
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
