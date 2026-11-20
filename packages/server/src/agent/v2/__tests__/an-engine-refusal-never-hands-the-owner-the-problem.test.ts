// v3.5 field fix 3, audit round (#4). The owner, 2026-11-04 (verbatim): "I was clear that the main agent
// owns the Mac they live in and the dojo doesn't limit them." / "I fucking LOVE when the agent tells
// the user "do it yourself"." (sarcastic: he is furious when it does).
//
// An engine refusal states its facts: it never tells the agent to hand the owner the engine's problem
// ("tell the person ... the engine blocked it") or to end its turn.

import { describe, it, expect } from 'vitest';
import { noteRepeatResult, repeatStopRefusal } from '../repeat-rule.js';
import type { TurnContext } from '../../turn-context.js';

describe('no engine refusal hands the owner the problem', () => {

  it('the repeat stop and its refusal state facts: no "End your turn now", no hatch', () => {
    const call = { tool: 'gmail_search', args: { query: 'in:inbox' } };
    const turn = { turnNumber: 1 } as TurnContext;
    let stop: string | null = null;
    for (let i = 0; i < 4; i++) stop = noteRepeatResult('agent-hatch', turn, call.tool, call.args, 'same');
    const refusal = repeatStopRefusal('agent-hatch', turn, call.tool, call.args) ?? '';
    for (const text of [stop ?? '', refusal]) {
      expect(text).toContain('the same result 4 times');
      expect(text).not.toMatch(/End your turn now/);
      expect(text).not.toMatch(/engine blocked it|tell the person/i);
    }
  });
});
