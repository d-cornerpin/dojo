/** The part of an agent payload this decision reads. Structural, so the card, a test
 *  fixture and a future list endpoint can all be its subject. */
export interface StopSubject {
  status: string;
  /** Live registry counts. `undefined` = an older server made no claim about live work. */
  inFlight?: { turn: number; background: number };
}

export interface StopAffordance {
  show: boolean;
  /** What the button says. Never a name, never a provider's wording. */
  label: string;
  why: string;
}

const NOTHING: StopAffordance = { show: false, label: 'Stop', why: '' };

export function stopAffordance(agent: StopSubject): StopAffordance {
  if (agent.status === 'terminated') return NOTHING;

  const turn = agent.inFlight?.turn ?? 0;
  const background = agent.inFlight?.background ?? 0;
  const working = agent.status === 'working';

  if (working) {
    return background > 0
      ? {
        show: true,
        label: 'Stop',
        why: background === 1
          ? 'Working, and one background job is still running. Stop cuts both.'
          : `Working, and ${background} background jobs are still running. Stop cuts all of them.`,
      }
      : { show: true, label: 'Stop', why: 'Working right now.' };
  }

  if (background > 0) {
    return {
      show: true,
      label: background === 1 ? 'Stop background job' : 'Stop background jobs',
      why: background === 1
        ? 'One job is still running in the background after the turn ended.'
        : `${background} jobs are still running in the background after the turn ended.`,
    };
  }

  // A non-working status with a turn in flight is a race, not a state: the status write and
  // the registry are not one transaction, and offering the button is the honest side of it.
  if (turn > 0) {
    return { show: true, label: 'Stop', why: 'A call is still in flight for this agent.' };
  }

  return NOTHING;
}


/** Where the composer's stop control goes, if anywhere. Exactly one of the three. */
export type ComposerStopControl = 'none' | 'instead-of-send' | 'beside-send';

export interface ComposerStopSubject {
  isWorking: boolean;
  canStop: boolean;
  hasHandler: boolean;
}

export function composerStopControl(o: ComposerStopSubject): ComposerStopControl {
  if (!o.hasHandler) return 'none';
  // A working turn wins the seat. `canStop` is true for a turn as well (it is the wider
  // question), so the order of these two branches is what keeps them from both matching.
  if (o.isWorking) return 'instead-of-send';
  if (o.canStop) return 'beside-send';
  return 'none';
}
