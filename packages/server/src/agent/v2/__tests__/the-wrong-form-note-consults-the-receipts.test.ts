// The wrong-form A2A note: with a reply on record it never tells the agent to send again; with none it
// draws the fresh-miss note word for word. Which record counts is pinned by
// `steps/post-call-classify/__tests__/a-send-on-the-thread-marks-the-request-replied.test.ts`.
import { describe, it, expect } from 'vitest';
import { a2aReplyEnforcer } from '../classifiers/a2a.js';

const PEER = 'HarnessBot';
const THREAD_SHORT = 'bc9cf088';

const base = {
  triggeredByReplyNeededIntent: true,
  sentToAgentThisTurn: false,
  alreadyNudgedForMissedReply: false,
  agentProducedText: true,
  intent: 'QUESTION',
  threadShort: THREAD_SHORT,
  fromName: PEER,
};

/** The fresh-miss note, verbatim. A genuinely unsent reply must still draw exactly this. */
const FRESH_MISS_NOTE =
  `[System: You received an [A2A:QUESTION] message from ${PEER} on thread ${THREAD_SHORT} `
  + `but you wrote your reply as text in your own chat instead of calling send_to_agent. `
  + `Other agents CANNOT see your chat — only the user can. ${PEER} got nothing. `
  + `Retry your reply now using send_to_agent with the same thread_id from the message you received. `
  + `Choose an intent that matches your response (ANSWER if you're answering a QUESTION, `
  + `COMPLETE/STATUS/FAIL if you finished or are still working, ASSIGN if delegating further). `
  + `Then end your turn.]`;

/** The already-replied note, verbatim. It never instructs a re-send. */
const ALREADY_REPLIED_NOTE =
  `[System: You already replied to ${PEER}'s [A2A:QUESTION] on thread ${THREAD_SHORT} `
  + `via send_to_agent in an earlier turn — ${PEER} has the message. `
  + `The text you just wrote is going to your own chat (only the user sees it), not to ${PEER}. `
  + `If you're done with this thread, just END YOUR TURN — do nothing further. `
  + `Only call send_to_agent again if you have NEW information for ${PEER} (use the same thread_id, intent STATUS or ANSWER as appropriate).]`;

describe('the wrong-form note reads the reply on record', () => {
  it('no reply on record: the fresh-miss note fires word for word', () => {
    const r = a2aReplyEnforcer({ ...base, priorReplyOnSameThread: false });
    expect(r.decision).toBe('nudge');
    if (r.decision === 'nudge') expect(r.nudgeText).toBe(FRESH_MISS_NOTE);
  });

  it('a reply on the thread: the note stops claiming the peer got nothing', () => {
    const r = a2aReplyEnforcer({ ...base, priorReplyOnSameThread: true });
    expect(r.decision).toBe('nudge');
    if (r.decision === 'nudge') {
      expect(r.nudgeText).toBe(ALREADY_REPLIED_NOTE);
      expect(r.nudgeText).not.toContain('Retry your reply now');
    }
  });

  it('the four no_action arms are untouched by a reply on record', () => {
    const withReply = { ...base, priorReplyOnSameThread: true };
    expect(a2aReplyEnforcer({ ...withReply, triggeredByReplyNeededIntent: false }).decision).toBe('no_action');
    expect(a2aReplyEnforcer({ ...withReply, sentToAgentThisTurn: true }).decision).toBe('no_action');
    expect(a2aReplyEnforcer({ ...withReply, alreadyNudgedForMissedReply: true }).decision).toBe('no_action');
    expect(a2aReplyEnforcer({ ...withReply, agentProducedText: false }).decision).toBe('no_action');
  });
});
