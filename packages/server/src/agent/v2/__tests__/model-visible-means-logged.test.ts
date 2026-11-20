// ════════════════════════════════════════════════════════════════════════════════════════
// HL3 — MODEL-VISIBLE MEANS LOGGED. The conformance invariant.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// dsh's own architecture doc states the rule this file enforces: *"Anything that reaches a
// model request must be reconstructable from the log, and a runtime invariant asserts it."*
// The dojo's version is bounded to the TAIL — the engine's own injections — because the
// prefix is already a projection of `messages` rows by construction.
//
// ── WHY THIS IS A GUARD AND NOT A ONE-OFF ───────────────────────────────────────────────
// The steer queue (`steer-queue.ts`) carries injection payloads IN MEMORY. A steer that is
// written, delivered and never persisted is a thing the model demonstrably saw and that no
// query can recover: every hard investigation of the last month began by reconstructing
// what the model saw from thinking dumps. The context receipt is NOT the answer — it is
// debug-gated (`receipt.ts:9`, "off by default") and writes files under `~/.dojo/receipts`,
// so on a normal box it records nothing at all.
//
// The HL3 census (2026-08-15, `task-W26-report.md` §1) measured the gap at `89da110`:
// **29 steer floors, 21 row-backed, 8 row-less across 9 producer sites**, plus one raw
// in-memory splice (`agent/runtime.ts`'s vision-gate nudge) that reached a model without a
// durable row AND without a lane tag. Every one of those nine sites failed clause 1 below
// before the fix landed; the splice failed clause 3.
//
// ── THE TWO HALVES OF THE INVARIANT ─────────────────────────────────────────────────────
//   1. SOURCE (here): every model-visible injection pairs a durable row carrying the SAME
//      content, and no raw insertion into an in-flight model array escapes the tagged,
//      row-backed channel. This is the half that catches the NEXT injection before it ships.
//   2. RUNTIME (`integration.test.ts`, "HL3: model-visible means logged"): a real turn is
//      driven, the array handed to `callModel` is captured, and every non-prefix message in
//      it is shown to be derivable from a durable row. That is the dsh assertion itself.
//
// The two are complementary and neither replaces the other: the source scan cannot prove
// the row and the message agree byte-for-byte at run time, and the driven clause exercises
// one floor, not thirty.
//
// ── WHAT COUNTS AS A DURABLE ROW, AND WHY IT IS NOT AN EVENTS-LANE ROW ──────────────────
// A `messages` row carrying the steer's content, written at injection time with the turn
// number. The sanctioned writers are `persistEngineSteer` (which does the row AND the queue
// entry in one call), `insertMessageIfAbsent` and `insertEngineEventIfAbsent`.
//
// HL3's text says "events-lane row". The eight sites this task repaired write `role='system'`
// rows through `persistEngineSteer` instead, and the reason is a measured one rather than a
// preference: an events-lane row written with the default `role='user'` IS LIFTED BACK INTO
// THE MODEL'S CONTEXT on a later turn (`memory/assembler.ts:1357-1361` selects
// `role === 'user' && origin.kind === 'engine'` into `lane.events`; the thrash-gate and
// delegation-hint sites say so in their own comments). That would add model-visible prompt
// bytes on the next turn — a prompt change, which this sitting forbids and which HL3's own
// intent inventory rules out ("rows are receipts, not carriers … zero prompt-byte movement").
// A `role='system'` row is stripped from model context by the assembler, classifies as
// `{ tier: 'agent-only', kind: 'engine-note' }` (`shared/src/visibility.ts:562-585`), and is
// exactly the carrier three of the already-compliant floors were using.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
// The registry assembler, not the bare container: importing it is what REGISTERS the
// entries (`prompt/registry/assembler.ts:24` imports `./entries.js` for its side effect), and
// `renderMessageEntry` is the exact function the drain calls, so this clause exercises the
// production path rather than a hand-picked entry object.
import { renderMessageEntry } from '../../../prompt/registry/assembler.js';
import { registeredIds } from '../../../prompt/registry/registry.js';
import type { AssemblyContext } from '../../../prompt/registry/types.js';
import { emptySteerQueue, enqueueSteer, nextSteer } from '../steer-queue.js';

// ── Clause 3: the carrier is byte-transparent ────────────────────────────────────────────
//
// The row proves what was WRITTEN. This clause is the link that makes it prove what was
// SEEN: the queue entry's content reaches the model unmodified, so `row.content ===
// entry.content === the message the provider was handed`. If `msg.pending-nudge` ever
// started wrapping, prefixing or truncating the steer, every row in the store would become
// an approximation of what the model read, and clause 1 would be guarding the wrong string.

describe('HL3 clause 3: the steer carrier does not alter the bytes it carries', () => {
  it('msg.pending-nudge renders the queue entry content byte-identically', () => {
    expect(registeredIds(), 'msg.pending-nudge is not registered — the drain has no carrier')
      .toContain('msg.pending-nudge');

    const steerText =
      '[Engine hint: the user has not heard anything from you yet this turn.]\nSecond line, and a trailing space. ';
    const q = enqueueSteer(emptySteerQueue(), { floor: 'start-ack', content: steerText, atLoop: 1 });
    const queued = nextSteer(q);
    expect(queued?.content).toBe(steerText);

    const msg = renderMessageEntry('msg.pending-nudge', { pendingSteer: queued!.content } as unknown as AssemblyContext);
    expect(msg).toBeTruthy();
    expect(msg!.role).toBe('user');
    expect(msg!.content).toBe(steerText);
  });

  it('renders nothing when no steer is pending (the drain is the only writer)', () => {
    expect(renderMessageEntry('msg.pending-nudge', { pendingSteer: null } as unknown as AssemblyContext)).toBeNull();
  });
});
