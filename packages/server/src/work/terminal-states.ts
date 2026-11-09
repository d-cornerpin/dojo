import type { WorkState } from './store.js';

/**
 * The states a piece of work never leaves on its own, and those of Working board work, written ONCE in
 * a module whose only import is a type, so `store.ts` and the SQL builders in `tracker-view.ts` read them without
 * the import cycle that left a value import of `store.ts` undefined at load. `store.ts`
 * re-exports these; the SQL builders derive from them rather than spelling the list.
 */
export const TERMINAL_STATE_NAMES = ['done', 'failed', 'abandoned'] as const;
export const TERMINAL_STATES: readonly WorkState[] = TERMINAL_STATE_NAMES;
export const isTerminal = (s: WorkState): boolean => TERMINAL_STATES.includes(s);
/** The row-level test on a raw state string (SQL rows, request bodies): true for done/failed/abandoned. */
export const isTerminalName = (s: string | null | undefined): boolean => !!s && (TERMINAL_STATE_NAMES as readonly string[]).includes(s);

/** The states of Working board work: claimed, or sent back and continued by its worker. */
export const WORKING_STATES = ['claimed', 'sent_back'] as const;
/** SQL: the row under alias `a` is Working (with `open`, Open or Working). */
export const workingExpr = (a: string, open = false): string =>
  `(${a}.state IN (${[...(open ? ['open'] : []), ...WORKING_STATES].map((s) => `'${s}'`).join(', ')}))`;
