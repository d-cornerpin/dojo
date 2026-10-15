// t179 (Run 15 S2 attempt 1): asked "You there?", the agent drafted "…your two items (the RWNWC0KXA10DEL
// check for tomorrow, the garage receipt ledger) are both on my list and open." That is a STATUS of work
// already on its board (task "Check the handover note RWNWC0KXA10DEL", opened turns earlier), not a new
// promise. The floor only asked the ledger for rows from THIS turn, so it fired, forced a duplicate
// commitment, and the turn went silent twice before the reply stood. A claim that names work already
// open on the board is answered by that work; a claim naming nothing open still fires.
import { describe, it, expect } from 'vitest';
import { decideUncommittedPromise } from '../recorded-commitment.js';

const base = { agentId: 'a1', toolResultsThisTurn: [], openedWorkThisTurn: () => [] as string[] };
const REPLY = 'Yep, still here. Your two items (the RWNWC0KXA10DEL check for tomorrow, the garage receipt ledger) are both on my list and open.';

describe('t179: a status of listed work is not a new promise', () => {
  it('the measured shape: the claim names an OPEN board row from an earlier turn → stands down', () => {
    const d = decideUncommittedPromise({ ...base, responseText: REPLY,
      openBoardTitles: () => ['Check the handover note RWNWC0KXA10DEL', 'Garage receipt ledger'] });
    expect(d).toEqual({ fires: false, reason: 'claim-names-open-work' });
  });
  it('a claim naming nothing open still fires (a NEW promise said to be recorded, with no row)', () => {
    const d = decideUncommittedPromise({ ...base, responseText: 'Done, the dentist reminder is on my list.',
      openBoardTitles: () => ['Check the handover note RWNWC0KXA10DEL'] });
    expect(d.fires).toBe(true);
  });
  it('common words do not match (a shared "the", "note" or "list" is not naming the work)', () => {
    const d = decideUncommittedPromise({ ...base, responseText: 'I noted the follow-up on my list.',
      openBoardTitles: () => ['Check the handover note RWNWC0KXA10DEL'] });
    expect(d.fires).toBe(true);
  });
  it('CONTROL: with no open board titles supplied the floor behaves as before', () => {
    const d = decideUncommittedPromise({ ...base, responseText: REPLY });
    expect(d.fires).toBe(true);
  });
});
