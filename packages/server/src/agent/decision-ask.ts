// One decide() call for the owner's on-the-model questions; null otherwise means the rule answers.
// A bare purpose ("reply_claims") asks only those of its questions the owner put on the model, by name.
import { decide } from './decide.js';
import { isYes, onTheModel } from './decision-policy.js';
import { installJudgment, type Judge } from './decision-hooks.js';

export const judgment: Judge = async (question, { agentId, state, questions }) => {
  const [purpose, only] = question.split('/');
  const asked = Object.fromEntries(Object.entries(questions).filter(([name]) => onTheModel(`${purpose}/${only ?? name}`)));
  if (Object.keys(asked).length === 0) return null;
  const answers = await decide(state, asked, { purpose, agentId }).catch(() => null);
  if (!answers) return null;
  return Object.fromEntries(Object.entries(answers).map(([name, a]) => [name, isYes(a.noul)]));
};

installJudgment(judgment);
