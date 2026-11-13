// One decide() call for the owner's on-the-model questions; null otherwise means the rule answers.
// A bare purpose ("reply_claims") asks only those of its questions the owner put on the model, by name;
// a combined judgment ("memory_shape/filler" with `combine`) answers once, under its own name.
import { decide } from './decide.js';
import { onTheModel, verdict } from './decision-policy.js';
import { installJudgment, type Judge } from './decision-hooks.js';

export const judgment: Judge = async (question, { agentId, state, questions, combine }) => {
  const [purpose, only] = question.split('/');
  const asked = Object.fromEntries(Object.entries(questions).filter(([name]) => onTheModel(`${purpose}/${only ?? name}`)));
  if (Object.keys(asked).length === 0) return null;
  const answers = await decide(state, asked, { purpose, agentId }).catch(() => null);
  if (!answers) return null;
  const p = Object.fromEntries(Object.entries(answers).map(([name, a]) => [name, a.noul]));
  const said = combine
    ? (Object.keys(p).length === Object.keys(asked).length ? [[only, verdict(question, combine(p))] as const] : [])
    : Object.entries(p).map(([name, x]) => [name, verdict(`${purpose}/${only ?? name}`, x)] as const);
  return Object.fromEntries(said.filter((e): e is readonly [string, boolean] => e[1] !== undefined));
};

installJudgment(judgment);
