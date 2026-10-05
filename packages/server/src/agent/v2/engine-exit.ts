// ════════════════════════════════════════════════════════════════════════════════════════
// WHO CUT THE TURN — the engine's own reason, carried from the site that ended it.
//
// ── THE DEFECT, MEASURED (10,934 turns on a lived-in box; BACKLOG line 17) ───────────────
// `turns.exit_reason` is a 17-value enum, CHECKed in the DB and published in the telemetry
// enum, and the production recorder could emit SIX of the words. EIGHT of the rest had no
// writer anywhere — `stop`, `preempt`, `abort`, `terminated`, `budget`, `provider_error`,
// `stream_idle`, `identical_call` — 0 rows each. Every one of those facts was KNOWN to the
// engine at the instant it ended the turn and then thrown away: an owner pressing STOP fell
// through to `no_reply_intended`, A CLAIM ABOUT THE MODEL'S INTENT for a turn the model
// never got to finish, and `work/ask-settlement.ts`'s re-serve ladder SPENT A RUNG on it.
// Four presses and the owner's unanswered question stops being re-served, having been
// neither answered nor declined. It is the same class as the `iteration_cap` zero C2 fixed,
// seven words wider — and the treatment was already decided
// (`work/exit-attribution.ts`'s `ENGINE_IMPOSED_EXITS` lists all eight); only the wiring
// was missing.
//
// ── WHY ONE CARRIER AND NOT EIGHT FLAGS ──────────────────────────────────────────────────
// `iteration_cap` was wired with one boolean on the turn's bag, which is the right shape for
// ONE fact. Eight of them would be eight booleans plus a precedence nobody wrote down. This
// is ONE field on the turn's own state — the same home, and the same stated reason, as
// `recallLaneReachedModelThisTurn`: one writer per site, one reader in teardown, no closure
// and no timer in between — and the precedence is a function with a test instead of a
// convention a reader has to reconstruct from the order of the arms.
//
// ── FIRST WRITER WINS, and it is not an arbitrary tie-break ──────────────────────────────
// The sites that latch here are the ones that END the turn, so the FIRST of them to speak is
// the most proximate cause and every later observer is describing the wreckage. Two shapes
// make that concrete, both real:
//
//   * STOP DURING A STREAM IDLE. The watchdog aborts, the dial throws the idle phrase, and
//     `steps/call-llm/model-call.ts`'s catch reads the stop fence BEFORE it rethrows — so
//     `stop` is latched there and the recovery arm never gets to say `stream_idle`. The
//     owner pressed the button; the stall is how the button was felt.
//   * A PROVIDER ERROR AFTER A STOP. Same catch, same order, same answer: `stop`. And
//     because an abort delivered THROUGH the stop door surfaces as an ordinary transport
//     failure on some providers, `classifyThrownCut` asks the fence FIRST rather than
//     trusting the error's own words.
//
// Nothing here can overwrite a latch, so a site cannot be made to lie by a later one.
// ════════════════════════════════════════════════════════════════════════════════════════

import { isStopFenced } from '../shared-state.js';
import { providerClassOf } from '../provider-error.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE, STREAM_IDLE_TIMEOUT_CODE } from '../stream-patience.js';
import { STREAM_FIRST_CHUNK_TIMEOUT_ERROR, STREAM_IDLE_TIMEOUT_ERROR } from '../model.js';
import { advance, type AgentTurnState } from './state.js';
import type { EngineCutReason } from './turn-record.js';

/**
 * Record WHY the engine (or the owner) ended this turn. First writer wins — see the header.
 *
 * Returns the advanced state, so a step latches and hands back in one expression and cannot
 * latch a fact onto a state it then drops on the floor.
 */
export function latchEngineCut(state: AgentTurnState, reason: EngineCutReason): AgentTurnState {
  if (state.engineCutExit !== null) return state;
  return advance(state, { engineCutExit: reason });
}

/**
 * Was this thrown error the stream watchdog cutting the call?
 *
 * BOTH the code and the phrase, because the throw sites genuinely disagree about which they
 * carry: three transports raise an `AgentError` with `code` set by `streamTimeoutCode`, and
 * the Anthropic seam's post-loop truth check (`agent/model.ts`, T65b) raises a plain `Error`
 * whose only identity is `streamTimeoutPhrase`'s words. A check that knew one of those would
 * silently miss the other, which is how a zero stays a zero.
 *
 * `declared_patience_exceeded` is HERE and not under `provider_error`: its own class
 * docstring says the request "failed to finish inside a bound its own owner set", i.e. the
 * same watchdog on the same stream, one bound earlier. Calling that the provider failing
 * would blame a remote box for a local stall.
 */
function cutByStreamWatchdog(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === STREAM_IDLE_TIMEOUT_CODE || code === DECLARED_PATIENCE_EXCEEDED_CODE) return true;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg.includes(STREAM_IDLE_TIMEOUT_ERROR) || msg.includes(STREAM_FIRST_CHUNK_TIMEOUT_ERROR);
}

/**
 * Was this an ABORT, as opposed to a failure?
 *
 * Shape-tested rather than `instanceof`, because four different libraries raise this: the
 * platform's `AbortSignal` throws a `DOMException` named `AbortError`, undici raises
 * `ABORT_ERR`, and the Anthropic SDK raises its own `APIUserAbortError`. `abortable-call.ts`
 * records the same reasoning for why the identity rides BESIDE the controller rather than
 * inside `abort(reason)`: every reader in the transports keys on the name.
 */
function isAbortError(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown } | null | undefined;
  if (!e) return false;
  const name = typeof e.name === 'string' ? e.name : '';
  return name === 'AbortError' || name === 'APIUserAbortError' || e.code === 'ABORT_ERR';
}

/**
 * Which engine-imposed exit a THROWN turn deserves, or null when the throw is not one.
 *
 * ── THE ORDER IS THE DECISION, and each step earns its place ──
 *   1. THE OWNER'S STOP, asked of the fence rather than of the error. `stopAgent` aborts
 *      in-flight calls, and an aborted dial surfaces as `AbortError` on one transport and as
 *      a bare socket failure on another; reading the error first would record the owner's
 *      press as `abort` or `provider_error` depending on who was serving.
 *   2. THE STREAM WATCHDOG. Before the provider class on purpose: an `AgentError` carrying
 *      `code: 'stream_idle_timeout'` reaches `classifyProviderError`'s PROSE table, which
 *      matches the word "timeout" in the watchdog's own message and answers `network` — the
 *      exact fold T81a's class split was written to stop, arriving from the other side.
 *   3. A PLAIN ABORT. Something cut this call and it was not the stop door and not the
 *      watchdog: a caller's own signal, a cancelled delegation, a background dial the turn
 *      was awaiting when the reaper swept it. `abort` is the honest word and the engine did
 *      end the turn, so the ladder must not charge the model for it.
 *   4. A PROVIDER VERDICT. Only a verdict the provider layer actually reached — a status, a
 *      body, a transport code. `'unknown'` is NOT one, and that refusal is deliberate:
 *      `markTurnDied`'s own docstring says the injury path must not name a cause it did not
 *      observe, so a TypeError in this engine stays `unknown` rather than being laundered
 *      into a provider's fault.
 */
export function classifyThrownCut(err: unknown, agentId: string): EngineCutReason | null {
  if (isStopFenced(agentId)) return 'stop';
  if (cutByStreamWatchdog(err)) return 'stream_idle';
  if (isAbortError(err)) return 'abort';
  return providerClassOf(err) === 'unknown' ? null : 'provider_error';
}
