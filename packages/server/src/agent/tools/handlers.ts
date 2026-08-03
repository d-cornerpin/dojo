// ════════════════════════════════════════════════════════════════════════════
// THE HANDLER TABLE (PHASE-5 T4)
//
// One map from DISPATCH KEY to the function that serves it, assembled from the
// per-category modules under `cat/` and `provider/`. This is the thing that
// replaces the switch in `agent/tools.ts`, one category at a time.
//
// ── WHY A STATIC IMPORT OF EVERY CATEGORY, AND WHY THAT IS NOT A CYCLE ──
// A category module may import leaves (`types.ts`, `pagination.ts`, `util.ts`,
// the brokers, the stores) and it may NOT import `agent/tools.ts`. That rule is
// what lets this module be statically imported BY `agent/tools.ts` without
// closing a loop, and it is the same rule that lets the moved bodies use static
// imports where the switch had to use `await import(…)`. A category that finds
// itself needing something from `agent/tools.ts` moves that something into
// `agent/tools/util.ts` first — that is the split, not a workaround for it.
//
// ── THE KEY IS THE DISPATCH KEY ──
// `workOperation(name, args) ?? name`, exactly as the switch keyed. Most tools
// key on their own name; the six work verbs key on `<verb>:<operation>`, which
// is why the table is not simply the registry indexed by tool name.
//
// ── ONE MECHANISM PER TOOL, ALWAYS ──
// A dispatch key is served by this table or by the switch that remains in
// `agent/tools.ts`, NEVER both: a category's move deletes its cases in the same
// commit that adds its module. Roadmap non-negotiable #1 is held here by
// construction and by `handler-table.test.ts`, which asserts the table's keys
// and the surviving case labels are disjoint.
// ════════════════════════════════════════════════════════════════════════════

import type { ToolHandler } from './handler.js';
import { recallHandlers } from './cat/recall.js';
import { vaultHandlers } from './cat/vault.js';
import { contactsHandlers } from './cat/contacts.js';
import { techniqueHandlers } from './cat/techniques.js';
import { healerHandlers } from './cat/healer.js';
import { clockHandlers } from './cat/clock.js';
import { platformHandlers } from './cat/platform.js';
import { commsHandlers } from './cat/comms.js';
import { trackerHandlers } from './cat/tracker.js';

const TABLE: ReadonlyMap<string, ToolHandler> = new Map<string, ToolHandler>([
  ...Object.entries(recallHandlers),
  ...Object.entries(vaultHandlers),
  ...Object.entries(contactsHandlers),
  ...Object.entries(techniqueHandlers),
  ...Object.entries(healerHandlers),
  ...Object.entries(clockHandlers),
  ...Object.entries(platformHandlers),
  ...Object.entries(commsHandlers),
  ...Object.entries(trackerHandlers),
]);

/** The handler for this dispatch key, or `undefined` if the switch still owns it. */
export function handlerFor(dispatchKey: string): ToolHandler | undefined {
  return TABLE.get(dispatchKey);
}

/** Every dispatch key this table serves. Consumed by the disjointness test and the registry. */
export function handledDispatchKeys(): readonly string[] {
  return [...TABLE.keys()];
}
