// Who cut the turn: one field on the turn state, latched first-writer-wins by the site that ended it.

import { isStopFenced } from '../shared-state.js';
import { turnContext } from '../turn-context.js';
import { providerClassOf } from '../provider-error.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE, STREAM_IDLE_TIMEOUT_CODE } from '../stream-patience.js';
import { STREAM_FIRST_CHUNK_TIMEOUT_ERROR, STREAM_IDLE_TIMEOUT_ERROR } from '../model.js';
import { advance, type AgentTurnState } from './state.js';
import type { EngineCutReason } from './turn-record.js';

// First writer wins: the first site to end the turn is the nearest cause, later ones only see the wreckage.
// Returns the advanced state so a step cannot latch onto a state it then drops.
export function latchEngineCut(state: AgentTurnState, reason: EngineCutReason): AgentTurnState {
  if (state.engineCutExit !== null) return state;
  return advance(state, { engineCutExit: reason });
}

// Did the turn end by parking the job (`jobParked`)? A park is invisible housekeeping: nothing owner-visible,
// queued files ride the real final reply. A stop refuses the wake, so a stopped agent parked nothing.
export function turnParkedTheJob(agentId: string): boolean {
  return !isStopFenced(agentId) && !!turnContext(agentId)?.jobParked;
}

// Both the code and the phrase: transports differ; declared patience is a local stall, not a provider fault.
function cutByStreamWatchdog(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === STREAM_IDLE_TIMEOUT_CODE || code === DECLARED_PATIENCE_EXCEEDED_CODE) return true;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg.includes(STREAM_IDLE_TIMEOUT_ERROR) || msg.includes(STREAM_FIRST_CHUNK_TIMEOUT_ERROR);
}

// Shape-tested, not instanceof: DOMException, undici ABORT_ERR and the SDK each raise their own abort.
function isAbortError(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown } | null | undefined;
  if (!e) return false;
  const name = typeof e.name === 'string' ? e.name : '';
  return name === 'AbortError' || name === 'APIUserAbortError' || e.code === 'ABORT_ERR';
}

// Order decides: stop fence first (an aborted dial looks like a plain failure), watchdog before the provider
// class ("timeout" would fold to network), then plain abort; `unknown` is never blamed on the provider.
export function classifyThrownCut(err: unknown, agentId: string): EngineCutReason | null {
  if (isStopFenced(agentId)) return 'stop';
  if (cutByStreamWatchdog(err)) return 'stream_idle';
  if (isAbortError(err)) return 'abort';
  return providerClassOf(err) === 'unknown' ? null : 'provider_error';
}
