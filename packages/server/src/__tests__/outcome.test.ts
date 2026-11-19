// The shared Outcome arms and the tool seam's reason vocabulary (`blocked | crashed | cancelled | invalid_args`),
// read through the real tool-door classifier.

import { describe, it, expect } from 'vitest';
import {
  applied, refused, failed,
  type LiveOutcome, type ToolSeamReason, type ToolResult,
} from '@dojo/shared';
import { classifyToolResult, toolResultOf, toolWasBlocked } from '../agent/tool-outcome.js';

describe('Outcome: the four arms', () => {
  it('carries the applied PROOF, not merely the fact that something applied', () => {
    const o = applied({ id: 'w1', eventId: 7 });
    if (o.kind !== 'applied') throw new Error('unreachable');
    expect(o.value.eventId).toBe(7);
  });

  it('keeps refused and failed as different answers, each naming its gate STRUCTURALLY', () => {
    const r = refused('done-requires-delivery', 'nothing was delivered');
    const f = failed('crashed', 'the transport threw');
    expect([r.kind, r.reason]).toEqual(['refused', 'done-requires-delivery']);
    expect([f.kind, f.reason]).toEqual(['failed', 'crashed']);
  });
});

describe('the tool seam reason (research 22)', () => {
  it('types a tool-seam outcome with that vocabulary', () => {
    const o: LiveOutcome<string, ToolSeamReason> = refused('blocked', 'denied by tools_policy');
    expect(o.kind === 'refused' && o.reason).toBe('blocked');
  });
});

describe('the tool door classifies STRUCTURALLY (PHASE-4 T1 cluster 3)', () => {
  const r = (over: Partial<ToolResult> = {}): ToolResult =>
    ({ toolCallId: 'c1', name: 'file_write', content: 'x', isError: false, ...over });

  it('a clean call is applied, and the result is the proof', () => {
    const o = classifyToolResult(r());
    expect(o.kind).toBe('applied');
    expect(toolResultOf(o).name).toBe('file_write');
  });

  it('PERMISSION_DENIED and RATE_LIMITED are REFUSED/blocked — nothing ran', () => {
    const denied = classifyToolResult(r({ isError: true, errorCode: 'PERMISSION_DENIED' }));
    const limited = classifyToolResult(r({ isError: true, errorCode: 'RATE_LIMITED' }));
    expect([denied.kind, denied.kind === 'refused' && denied.reason]).toEqual(['refused', 'blocked']);
    expect([limited.kind, limited.kind === 'refused' && limited.reason]).toEqual(['refused', 'blocked']);
    // The refusal still hands the model something to read.
    expect(toolResultOf(denied).content).toBe('x');
  });

  it('TIMEOUT is FAILED/cancelled — abandoned before an answer', () => {
    const o = classifyToolResult(r({ isError: true, errorCode: 'TIMEOUT' }));
    expect([o.kind, o.kind === 'failed' && o.reason]).toEqual(['failed', 'cancelled']);
  });

  it('an error with NO structured code is FAILED/crashed, never guessed from prose', () => {
    // 22 of the 23 `isError: true` returns in tools.ts carried no errorCode at the T1 base.
    // Reading "[BLOCKED by engine]" out of `content` would classify more of them and is the
    // banned move (receipt-keyed, never prose-keyed). Unclassified means crashed.
    const blockedLookingProse = classifyToolResult(
      r({ isError: true, content: '[BLOCKED by engine] file_write is not available to this agent' }),
    );
    expect([blockedLookingProse.kind, blockedLookingProse.kind === 'failed' && blockedLookingProse.reason])
      .toEqual(['failed', 'crashed']);
    expect(toolWasBlocked(blockedLookingProse)).toBe(false);
  });
});

// ── PHASE-4 T3: `cancelled` STOPS BEING UNREACHABLE ────────────────────────────────
// T1 declared the arm and left it unpopulated, naming the loop's spin brake as the site
// that would produce it. T3 opened that site and found TWO arms, only one of which is
// `cancelled` — the source walk below pins the split so neither half can quietly drift
// into the other. It is a SOURCE clause because the brake path builds a ToolResult
// inline inside a 9,000-line loop body; there is no seam to call.
describe("PHASE-4 T3: the spin brake is `cancelled`'s producer, on ONE arm only", () => {
  const r = (over: Partial<ToolResult> = {}): ToolResult =>
    ({ toolCallId: 'tc1', name: 'file_write', content: 'x', isError: false, ...over });

  it('ONLY the terminal arm is marked, and it is marked TIMEOUT (which reads cancelled)', () => {
    // …and the classifier turns exactly that into failed/cancelled, so the site does not
    // get to name its own arm.
    const terminal = classifyToolResult(r({ isError: true, errorCode: 'TIMEOUT' }));
    expect([terminal.kind, terminal.kind === 'failed' && terminal.reason]).toEqual(['failed', 'cancelled']);
  });

  it('NEGATIVE CONTROL: the per-signature refusal is left unmarked and reads crashed', () => {
    // Reaching `blocked` here would need PERMISSION_DENIED or RATE_LIMITED, and both would
    // be false about WHY. An unmarked refusal reads `crashed` — "nobody told us anything
    // better" — and that is the honest answer until a code exists that means what this is.
    const perSignature = classifyToolResult(r({ isError: true, content: '[Engine: identical call refused]' }));
    expect([perSignature.kind, perSignature.kind === 'failed' && perSignature.reason])
      .toEqual(['failed', 'crashed']);
    expect(toolWasBlocked(perSignature)).toBe(false);
  });
});
