import type { WorkState } from './store.js';

/**
 * The states a piece of work never leaves on its own, written ONCE in a module whose only
 * import is a type, so `store.ts` and the SQL builders in `tracker-view.ts` both read it without
 * the import cycle that left a value import of `store.ts` undefined at load. `store.ts`
 * re-exports these; nothing else may restate the list.
 */
export const TERMINAL_STATE_NAMES = ['done', 'failed', 'abandoned'] as const;
export const TERMINAL_STATES: readonly WorkState[] = TERMINAL_STATE_NAMES;
export const isTerminal = (s: WorkState): boolean => TERMINAL_STATES.includes(s);
