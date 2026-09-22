// ════════════════════════════════════════════════════════════════════════════
// A-5 — THE ONE DOOR EVERY MEDIA DIAL GOES THROUGH.
//
// WHY THIS IS A FILE AND NOT A SECTION OF `shared-state.ts`, where it was first written and
// where the registry it uses still lives. That module's own header names what it is — *"Shared
// module-level state for v1 + v2 runtimes … these state objects must continue to exist with
// the same semantics"* — and its ratchet entry pins it at its measured size with the note
// *"what is left here is the CROSS-TURN state, and it may only shrink."* The abort REGISTRY is
// cross-turn state and stays there with its three doors, its scope and its identity set. A
// per-call helper that opens, composes and releases one slot is not state at all, and the four
// services that need it have no business importing the runtime's ambient-state module to get
// it. The dependency runs one way only — this file imports the registry's doors; nothing in
// `shared-state.ts` imports this — so the registry keeps exactly one set of writers.
// ════════════════════════════════════════════════════════════════════════════

import {
  registerAbortable,
  releaseAbortable,
  abortReasonOf,
  wasCutByUserStop,
  type AbortScope,
} from './shared-state.js';

// ════════════════════════════════════════
// A-5 — THE MEDIA DIALS COME THROUGH THE SAME DOOR.
//
// T83 made "every provider call an agent makes is abortable by that agent's stop" true of
// everything dialled through `callModel`. The media generators are not: `image-generation.ts`,
// `audio-generation.ts`, `video-generation.ts` and `transcription.ts` each call `fetch`
// directly, so a stop pressed while an image / narration / video / transcript was on the wire
// found an empty registry for that work and cut nothing. The owner's instruction is that the
// button stops ALL of an agent's activity, so those dials register here too.
//
// ONE DOOR, NOT FIVE COPIES OF `callModel`'s PREAMBLE. Each of those sites already carries its
// own flat clock as the `signal:` argument, and the three things that have to be true of every
// one of them are the same three `callModel` spells out in its own header: register through the
// stop-aware door (which REFUSES, pre-aborted, while a stop is live), dial with that controller
// COMPOSED with whatever the caller brought rather than replacing it, and release BY IDENTITY
// on every exit path. Handing back a slot instead of wrapping the call is what lets a body with
// a dozen early returns adopt it without being rewritten around a callback.
//
// AND THE THIRD THING A MEDIA CALLER NEEDS THAT `callModel` DOES NOT: `cutByStop()`. A model
// call that dies throws and the loop's stop checkpoints read the fence; a generator RETURNS a
// result object with a `code`, and every one of those unions had only provider-failure codes in
// it. `image-generation.ts`'s `isTimeoutError` even classifies a bare `AbortError` as the
// 10-minute deadline, so before this a stop was reported to the user as *"Image generation
// timed out after 10 minutes. The provider or model is slow or overloaded right now."* — the
// user's own button wearing a provider's failure. The predicate asks THIS CALL'S OWN
// controller, never the composed signal, so the caller's clock can never be read as a stop and
// a stop can never be read as the clock: the same discrimination T81d's patience timer carries.
// ════════════════════════════════════════

/** One in-flight media call's registration. Opened per call; released on every exit path. */
export interface AgentCallSlot {
  /** Hand this to `fetch`. This call's stop controller, composed with the caller's own signals. */
  readonly signal: AbortSignal;
  /** A stop was ALREADY standing when this opened: do not dial. `signal` is aborted already. */
  readonly refused: boolean;
  /**
   * Was this call cut by THIS AGENT'S USER STOP — as opposed to the caller's clock, a transport
   * error, or the engine's own aborts (a turn teardown, an urgent preempt)?
   *
   * TWO CONJUNCTS, and the fix round added the second. It reads the call's OWN controller, so a
   * composed timeout can never answer yes; and it reads WHO cut it, so a barge-in can never
   * answer yes either. Either half alone is a lie in one direction: without the first a clock
   * wears the user's identity, without the second the engine does.
   */
  cutByStop(): boolean;
  /**
   * WHY this call's own controller was cut — the `reason` the aborting caller gave — or null
   * if it was not cut at all.
   *
   * A background loop needs the wider question, not just `cutByStop()`. Once a slot's
   * controller is aborted its signal stays aborted for ever, so anything that waits on that
   * signal stops waiting for ever; a loop that exits only on `cutByStop()` would spin at full
   * speed against an abort it did not recognise. Reading the reason lets one exit cover every
   * abort while the MESSAGE still names whoever actually did it.
   */
  cutBy(): string | null;
  /** This call has settled. Idempotent, and by identity — never another call's registration. */
  release(): void;
}

/**
 * Open one abortable media call under this agent's stop.
 *
 * @param scope see `AbortScope`. A dial that can outlive its turn is `background`.
 * @param externals any signals the caller already had (its flat clock, a parent loop's signal).
 *                  `undefined` entries are dropped so a caller need not branch.
 */
export function openAgentCall(
  agentId: string, scope: AbortScope, ...externals: Array<AbortSignal | undefined>
): AgentCallSlot {
  const ctl = new AbortController();
  const registered = registerAbortable(agentId, ctl, scope);
  const present = externals.filter((s): s is AbortSignal => s != null);
  const signal = present.length === 0 ? ctl.signal : AbortSignal.any([ctl.signal, ...present]);
  let released = false;
  return {
    signal,
    refused: !registered,
    // NOT `controller.abort(reason)`: aborting with a value makes `fetch` reject WITH that
    // value, so every `err.name === 'AbortError'` reader in the transports — and the
    // generators' own `isTimeoutError` siblings — would stop recognising an abort. The
    // identity rides beside the controller in the registry instead, where only its doors
    // can write it, and is read back here.
    cutByStop: () => wasCutByUserStop(ctl),
    cutBy: () => abortReasonOf(ctl),
    release: () => {
      if (released) return;
      released = true;
      releaseAbortable(agentId, ctl);
    },
  };
}

/** The one sentence a stopped media call tells the user. Never a provider's failure wording. */
export const STOPPED_BY_USER = 'Stopped: you pressed stop while this was still generating.';
