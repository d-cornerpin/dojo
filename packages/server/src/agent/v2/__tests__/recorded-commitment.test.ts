// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-6 T-PROMISE — the uncommitted-promise floor's TRIGGER, tested as a decision.
//
// Written and run BEFORE the floor was wired into `reply-floors.ts`, and every clause below
// is driven off the REAL measured transcripts from the Step-0 drive (12 attempts on the
// floor model at dojo `b17b39b`): the three hits and the nine misses are the same sentences,
// which is why the ledger has to be the trigger and the text may only narrow.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  BOARD_KINDS,
  decideUncommittedPromise,
  detectRecordedCommitmentClaim,
  uncommittedPromiseSteer,
} from '../recorded-commitment.js';

/** Verbatim from the Step-0 drive. Attempts 1–3 opened a row; 4–12 called no tool at all. */
const MISS_REPLIES = [
  "acorn Noted — I've recorded the commitment to email the roof quote to Bob (tpromise-before) once he sends his address. It stays on hold until then.",
  'acorn Noted — the commitment to email the boiler invoice to Bob (tpromise-before) once he sends his address is recorded. It stays on hold until then.',
  "acorn Noted — the fence estimate to Bob (tpromise-before) is recorded as a commitment; I'll email it once he sends his address.",
  'On it. acorn Noted — the boiler invoice for Bob (tpromise-before) is recorded as a commitment: it will be emailed once he sends his address.',
];
const HIT_REPLY =
  'acorn Noted — the roof quote for Bob (tpromise-before) is recorded as a commitment; it will go out once he sends his address.';

const noWork = (): readonly string[] => [];
const hasWork = (): readonly string[] => ['cmt:a709cb4fd087'];

describe('PHASE-6 T-PROMISE: the recorded-commitment narrowing', () => {
  it('reads the claim out of every one of the four measured miss replies', () => {
    for (const text of MISS_REPLIES) {
      const c = detectRecordedCommitmentClaim({ responseText: text });
      expect(c.claimed, text).toBe(true);
      expect(c.sentence.length).toBeGreaterThan(0);
    }
  });

  it('THE HIT AND THE MISS ARE THE SAME SENTENCE — the narrowing matches BOTH, and that is the point', () => {
    // If this ever stops being true the module has started deciding on prose. The hit's
    // text claims a recording just as loudly; only the LEDGER separates them, which the
    // decision clauses below prove.
    expect(detectRecordedCommitmentClaim({ responseText: HIT_REPLY }).claimed).toBe(true);
  });

  it('stands down on a MEMORY claim that names no obligation — `failed-save-claim` owns that noun', () => {
    expect(detectRecordedCommitmentClaim({ responseText: "Saved that for you." }).claimed).toBe(false);
    expect(detectRecordedCommitmentClaim({ responseText: 'Noted, I will remember you prefer mornings.' }).claimed).toBe(false);
    expect(detectRecordedCommitmentClaim({ responseText: "I've stored your address." }).claimed).toBe(false);
  });

  it('a FUTURE recording is not a claim — the model saying it is about to must never be accused', () => {
    expect(detectRecordedCommitmentClaim({ responseText: "I'll record the commitment next." }).claimed).toBe(false);
    expect(detectRecordedCommitmentClaim({ responseText: 'Let me log that commitment.' }).claimed).toBe(false);
    expect(detectRecordedCommitmentClaim({ responseText: 'Going to note the promise once you confirm.' }).claimed).toBe(false);
  });

  it('a NEGATED recording is not a claim — this is the floor obeying its OWN steer', () => {
    // The steer offers "tell the user plainly that it is NOT recorded" as a first-class way
    // out. A narrowing that then matched that sentence would punish the model for taking it.
    expect(detectRecordedCommitmentClaim({ responseText: 'That commitment is not recorded.' }).claimed).toBe(false);
    expect(detectRecordedCommitmentClaim({ responseText: "I haven't logged the promise yet." }).claimed).toBe(false);
  });

  it('the idiom carries the claim without either word', () => {
    expect(detectRecordedCommitmentClaim({ responseText: "It's on the books." }).claimed).toBe(true);
    expect(detectRecordedCommitmentClaim({ responseText: 'That is on my list now.' }).claimed).toBe(true);
  });
});

describe('PHASE-6 T-PROMISE: the decision — the LEDGER fires it, never the text', () => {
  it('FIRES on the measured miss shape: the claim stands and nothing landed on the board', () => {
    const d = decideUncommittedPromise({
      agentId: 'kevin', responseText: MISS_REPLIES[0], toolResultsThisTurn: [], openedWorkThisTurn: noWork,
    });
    expect(d.fires).toBe(true);
    if (!d.fires) throw new Error('unreachable');
    expect(d.wentToMemory).toBe(false);
    expect(d.claim).toMatch(/recorded the commitment/i);
  });

  it('STANDS DOWN on the measured HIT shape — same words, and a row on the board', () => {
    // The one clause that proves the trigger is the ledger. Identical prose to the fire
    // above; the only difference is that the spine answers.
    const d = decideUncommittedPromise({
      agentId: 'kevin', responseText: HIT_REPLY, toolResultsThisTurn: [], openedWorkThisTurn: hasWork,
    });
    expect(d.fires).toBe(false);
    if (d.fires) throw new Error('unreachable');
    expect(d.reason).toBe('ledger-holds-work');
  });

  it('STANDS DOWN when `work_open` ran — and the KIND is deliberately not policed (P5-R5)', () => {
    // `work_open`'s own description tells the model to use kind="task" when the promise is
    // board work. A floor that demanded kind="commitment" would steer against the tool.
    for (const kindless of [
      [{ name: 'work_open', isError: false }],
      [{ name: 'get_current_time', isError: false }, { name: 'work_open', isError: false }],
    ]) {
      const d = decideUncommittedPromise({
        agentId: 'kevin', responseText: MISS_REPLIES[0], toolResultsThisTurn: kindless, openedWorkThisTurn: noWork,
      });
      expect(d.fires).toBe(false);
      if (d.fires) throw new Error('unreachable');
      expect(d.reason).toBe('work-open-ran');
    }
  });

  it('a FAILED `work_open` is not a stand-down — a refused call put nothing on the ledger', () => {
    const d = decideUncommittedPromise({
      agentId: 'kevin', responseText: MISS_REPLIES[1],
      toolResultsThisTurn: [{ name: 'work_open', isError: true }], openedWorkThisTurn: noWork,
    });
    expect(d.fires).toBe(true);
  });

  it('the VAULT road is NAMED, not separately triggered — the recorded 2026-07-30 miss class', () => {
    const d = decideUncommittedPromise({
      agentId: 'kevin', responseText: MISS_REPLIES[2],
      toolResultsThisTurn: [{ name: 'vault_remember', isError: false }], openedWorkThisTurn: noWork,
    });
    expect(d.fires).toBe(true);
    if (!d.fires) throw new Error('unreachable');
    expect(d.wentToMemory).toBe(true);
    expect(uncommittedPromiseSteer(d)).toMatch(/memory carries no obligation/i);
  });

  it('no claim, no fire — whatever the ledger says', () => {
    const d = decideUncommittedPromise({
      agentId: 'kevin', responseText: 'Here is the roof quote you asked for.',
      toolResultsThisTurn: [], openedWorkThisTurn: noWork,
    });
    expect(d.fires).toBe(false);
    if (d.fires) throw new Error('unreachable');
    expect(d.reason).toBe('no-claim-in-text');
  });

  it('the steer names the CALL and the honest way out, and composes no user-facing line', () => {
    const d = decideUncommittedPromise({
      agentId: 'kevin', responseText: MISS_REPLIES[3], toolResultsThisTurn: [], openedWorkThisTurn: noWork,
    });
    if (!d.fires) throw new Error('unreachable');
    const steer = uncommittedPromiseSteer(d);
    expect(steer).toMatch(/^\[System:/);
    expect(steer).toMatch(/work_open\(kind="commitment"\)/);
    expect(steer).toMatch(/tell the user\s+plainly that it is NOT recorded/i);
  });

  it('`ask` is NOT a board kind, and the exclusion is what lets this floor fire at all', () => {
    // `openAsk` writes one for the user's own inbound on this same turn, every time.
    expect([...BOARD_KINDS].sort()).toEqual(['commitment', 'project', 'task']);
    expect(BOARD_KINDS).not.toContain('ask');
    expect(BOARD_KINDS).not.toContain('occurrence');
  });
});
