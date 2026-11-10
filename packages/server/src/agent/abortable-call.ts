
import { announceLiveWork } from './live-work.js';
import {
  registerAbortable,
  releaseAbortable,
  abortReasonOf,
  wasCutByUserStop,
  type AbortScope,
} from './shared-state.js';


export interface AgentCallSlot {
  readonly signal: AbortSignal;
  /** A stop was ALREADY standing when this opened: do not dial. `signal` is aborted already. */
  readonly refused: boolean;
  /** True only when THIS agent's user stop cut it; a clock or the engine aborts the same controller. */
  cutByStop(): boolean;
  /** Why its controller was cut, or null. The abort is final, so a background loop exits on any reason. */
  cutBy(): string | null;
  release(): void;
}

export function openAgentCall(
  agentId: string, scope: AbortScope, ...externals: Array<AbortSignal | undefined>
): AgentCallSlot {
  const ctl = new AbortController();
  const registered = registerAbortable(agentId, ctl, scope);
  const present = externals.filter((s): s is AbortSignal => s != null);
  const signal = present.length === 0 ? ctl.signal : AbortSignal.any([ctl.signal, ...present]);
  let released = false;
  // Background dials outlive their turn, which no `agent:status` frame describes; announce open and release.
  if (scope === 'background') announceLiveWork(agentId);
  return {
    signal,
    refused: !registered,
    // Never `abort(reason)`: fetch rejects WITH the value, breaking every AbortError reader.
    cutByStop: () => wasCutByUserStop(ctl),
    cutBy: () => abortReasonOf(ctl),
    release: () => {
      if (released) return;
      released = true;
      releaseAbortable(agentId, ctl);
      if (scope === 'background') announceLiveWork(agentId);
    },
  };
}

/** The one sentence a stopped media call tells the user. Never a provider's failure wording. */
export const STOPPED_BY_USER = 'Stopped: you pressed stop while this was still generating.';
