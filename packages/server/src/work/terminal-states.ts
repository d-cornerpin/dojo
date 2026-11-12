import type { WorkState } from './store.js';

/** States work never leaves; a type-only import keeps `store.ts` and `tracker-view.ts` acyclic. */
export const TERMINAL_STATE_NAMES = ['done', 'failed', 'abandoned'] as const;
export const TERMINAL_STATES: readonly WorkState[] = TERMINAL_STATE_NAMES;
export const isTerminal = (s: WorkState): boolean => TERMINAL_STATES.includes(s);
export const isTerminalName = (s: string | null | undefined): boolean => !!s && (TERMINAL_STATE_NAMES as readonly string[]).includes(s);

export const WORKING_STATES = ['claimed', 'sent_back'] as const;
export const workingExpr = (a: string, open = false): string =>
  `(${a}.state IN (${[...(open ? ['open'] : []), ...WORKING_STATES].map((s) => `'${s}'`).join(', ')}))`;
