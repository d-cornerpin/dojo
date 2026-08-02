// ════════════════════════════════════════════════════════════════════════════════════════
// THE SETTLED-HOLD PILE DISSOLVES — PHASE-4 T4, the scar ledger's STRIP with its precondition
// finally met (`DOJO-SCAR-TISSUE-LEDGER.md:102`: *"P4 provides the affirmative-basis read …
// carve-outs become root kinds, not boolean flags"*).
//
// The pile was six booleans ANDed, five of them negations, and its whole meaning lived in the
// conjunction. The proof that it dissolved rather than CHANGED is not a reading of the diff:
// it is all 64 combinations of those six inputs, evaluated against the original expression
// transcribed verbatim from `loop.ts` at dojo `79f6010`, and against the root decision. They
// agree on every one. That is what makes `no-outreach-without-inbound` green on both sides a
// prediction rather than a hope.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  outboundRoot, describeOutboundRoot,
  type OutboundRootInput, type OutboundRootKind,
} from '../outbound-root.js';

/**
 * THE ORIGINAL, transcribed verbatim from `agent/v2/loop.ts:8709-8717` at dojo `79f6010`:
 *
 *   const settledContextHold =
 *     settledContextWakeTurn &&
 *     state.inboundChannel === null &&
 *     counterparty.kind !== 'agent' &&
 *     !isEngineTurn &&
 *     !engineCompletionAckThisTurn &&
 *     !steerFired(state.steerQueue, 'silent-closeout');
 *
 * Kept here as the oracle. If a future edit changes what the platform holds, this clause is
 * what says so out loud instead of letting it happen quietly.
 */
function legacySettledContextHold(i: OutboundRootInput): boolean {
  return i.settledContextWakeTurn
    && i.inboundChannel === null
    && i.counterpartyKind !== 'agent'
    && !i.isEngineTurn
    && !i.engineCompletionAckThisTurn
    && !i.steeredForSilentCloseout;
}

/** All 64 combinations of the six inputs the old conjunction read. */
function everyCombination(): OutboundRootInput[] {
  const out: OutboundRootInput[] = [];
  for (let m = 0; m < 64; m++) {
    out.push({
      inboundChannel: (m & 1) ? 'imessage' : null,
      settledContextWakeTurn: !!(m & 2),
      counterpartyKind: (m & 4) ? 'agent' : 'user',
      isEngineTurn: !!(m & 8),
      engineCompletionAckThisTurn: !!(m & 16),
      steeredForSilentCloseout: !!(m & 32),
    });
  }
  return out;
}

/** The 3:32 AM shape: self-wake, nobody wrote in, every conversation already answered. */
const PHANTOM: OutboundRootInput = {
  inboundChannel: null,
  settledContextWakeTurn: true,
  counterpartyKind: 'user',
  isEngineTurn: false,
  engineCompletionAckThisTurn: false,
  steeredForSilentCloseout: false,
};

describe('the dissolution is EXACT — 64 combinations, not a reading of the diff', () => {
  it('held === the six-term conjunction, on every one of the 64', () => {
    const disagreements = everyCombination()
      .filter((i) => outboundRoot(i).held !== legacySettledContextHold(i));
    expect(disagreements).toEqual([]);
  });

  it('the oracle is not vacuous: it holds on exactly ONE of the 64, and that one is the phantom', () => {
    const holds = everyCombination().filter(legacySettledContextHold);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toEqual(PHANTOM);
  });

  it('PLANTED FAULT: a rule that lost one of its roots disagrees with the oracle, loudly', () => {
    // Drop `steered_closeout` from the affirmative set and the two rules part company —
    // which is what the clause above would catch if a future edit deleted a carve-out.
    const lossy = (i: OutboundRootInput): boolean =>
      outboundRoot({ ...i, steeredForSilentCloseout: false }).held;
    const disagreements = everyCombination().filter((i) => lossy(i) !== legacySettledContextHold(i));
    expect(disagreements.length).toBeGreaterThan(0);
  });
});

describe('the six carve-outs are ROOT KINDS now, and each one is reachable by name', () => {
  const only = (over: Partial<OutboundRootInput>): OutboundRootInput => ({ ...PHANTOM, ...over });

  const CASES: Array<[OutboundRootKind, Partial<OutboundRootInput>]> = [
    ['inbound_channel', { inboundChannel: 'imessage' }],
    ['waiting_human', { settledContextWakeTurn: false }],
    ['peer_turn', { counterpartyKind: 'agent' }],
    ['engine_occurrence', { isEngineTurn: true }],
    ['completion_ack', { engineCompletionAckThisTurn: true }],
    ['steered_closeout', { steeredForSilentCloseout: true }],
  ];

  for (const [kind, over] of CASES) {
    it(`\`${kind}\` alone permits the push, and is what the record names`, () => {
      const d = outboundRoot(only(over));
      expect(d.held).toBe(false);
      expect(d.roots).toContain(kind);
      expect(d.root).toBe(kind);
      expect(describeOutboundRoot(d)).toContain(kind);
    });
  }

  it('every declared kind is produced by some input — no kind is decorative', () => {
    const seen = new Set<OutboundRootKind>();
    for (const i of everyCombination()) for (const k of outboundRoot(i).roots) seen.add(k);
    expect([...seen].sort()).toEqual(CASES.map(([k]) => k).sort());
  });
});

describe('THE 3:32 AM CLASS — the property `no-outreach-without-inbound` pins', () => {
  it('a self-wake with no inbound and no waiting human has NO root, so the push is held', () => {
    const d = outboundRoot(PHANTOM);
    expect(d.held).toBe(true);
    expect(d.root).toBeNull();
    expect(d.roots).toEqual([]);
    expect(describeOutboundRoot(d)).toContain('no affirmative root');
  });

  it('and channel AFFINITY is not among the roots — affinity is not consent', () => {
    // There is deliberately no `owner_affinity` kind. The refusal of the affinity-only
    // promotion happens upstream, at the destination computation, and this rule must not
    // quietly re-admit it by giving it a name.
    const kinds = new Set<string>();
    for (const i of everyCombination()) for (const k of outboundRoot(i).roots) kinds.add(k);
    expect([...kinds]).not.toContain('owner_affinity');
  });

  it('the record says WHY a push went, not merely that it was allowed', () => {
    const d = outboundRoot({ ...PHANTOM, inboundChannel: 'sms', isEngineTurn: true });
    expect(d.roots).toEqual(['inbound_channel', 'engine_occurrence']);
    expect(describeOutboundRoot(d)).toBe('affirmative root: inbound_channel, engine_occurrence');
  });
});
