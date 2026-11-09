// PHASE-4 T1 Step 1 — the five-way `Outcome<T>` and its quarantine.
//
// These clauses pin the three things the phase buys, and nothing else:
//   1. the five arms exist and are distinguishable (a boolean cannot do this);
//   2. the tool seam's reason vocabulary is `blocked | crashed | cancelled`;
//   3. `unknown` is QUARANTINED to non-live data, at every wall that claims to
//      hold it — and the quarantine is proven by watching it REFUSE, never by
//      watching a legal call succeed.
//
// Wall 2 (the `LiveOutcome` type excluding the arm) is a COMPILE-time guarantee,
// so it cannot be asserted from a runtime test — `packages/server/tsconfig.json`
// excludes `__tests__` from `npm run typecheck`, so a `@ts-expect-error` here
// would be a comment. It is proven instead by the burn-down: `WorkOutcome` and
// `ToolOutcome` are built on `LiveOutcome`, and a hand-planted `unknown` arm in
// either fails `npm run typecheck`. That proof is in the T1 report, with its
// command and its output.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTCOME_KINDS,
  applied, refused, failed,
  type Outcome, type ToolSeamReason, type ToolResult,
} from '@dojo/shared';
import { classifyToolResult, toolResultOf, toolWasBlocked } from '../agent/tool-outcome.js';
import { engineText, engineFileContaining } from '../agent/v2/__tests__/engine-sources.js';

describe('Outcome<T>: the five arms', () => {
  it('declares exactly five kinds, in the argued order', () => {
    expect([...OUTCOME_KINDS]).toEqual(['applied', 'no_change', 'refused', 'failed', 'unknown']);
  });

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
    const o: Outcome<string, ToolSeamReason> = refused('blocked', 'denied by tools_policy');
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
  // PHASE-6 GUARD-AUDIT 2026-08-04: the comment above says it — "inside a 9,000-line loop
  // body". PHASE-6 is what ends that, and the spin brake rides the `execute` tranche out of
  // `loop.ts` into `agent/v2/steps/`. Reading the driver alone would have made both clauses
  // below fail for a reason that has nothing to do with their requirement, so the corpus is
  // the ENGINE — driver plus every step package.
  const engine = () => engineText();

  it('the brake routes its refusal through the classifier instead of hand-building a result', () => {
    // Pre-T3 the site was `toolResult = { toolCallId, name, content: refusal, isError: true }`
    // — a result that never met the classifier at all, which is WHY the arm had no producer.
    //
    // A PROXIMITY clause (200 chars), so it is pinned to the ONE engine file that holds the
    // construction: measured across a concatenated corpus the distance would be read over a
    // file join. A tranche that splits the pair fails loudly rather than matching by accident.
    const home = engineFileContaining('toolResultOf(classifyToolResult({');
    expect(home, 'no engine file builds the brake refusal through the classifier').not.toBeNull();
    expect(home!.text).toMatch(/toolResultOf\(classifyToolResult\(\{[\s\S]{0,200}?content: refusal/);
  });

  it('ONLY the terminal arm is marked, and it is marked TIMEOUT (which reads cancelled)', () => {
    expect(engine()).toMatch(/toolPhaseEndedBySpinBrake \? \{ errorCode: 'TIMEOUT' as const \} : \{\}/);
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
