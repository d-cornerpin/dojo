// ════════════════════════════════════════════════════════════════════════════
// THE HANDLER TABLE (PHASE-5 T4)
//
// One map from DISPATCH KEY to the function that serves it, assembled from the
// per-category modules under `cat/` and `provider/`. It REPLACED the 268-case
// switch in `agent/tools.ts` — a file that no longer exists — and it is now the
// only place a tool name becomes a function call.
//
// ── WHAT A CATEGORY MODULE MAY IMPORT ──
// Leaves: `types.ts`, `pagination.ts`, `util.ts`, `surface.ts`,
// `definitions.ts`, the brokers, the stores. NOT the executor
// (`agent/tools/index.ts`) — that is the one edge that would close a loop
// through this module, and it is the rule that lets the moved bodies use plain
// static imports where the switch had to use `await import(…)`. A category that
// finds itself needing something from the executor moves that something into a
// leaf first — that is the split, not a workaround for it.
//
// ── THE KEY IS THE DISPATCH KEY ──
// `workOperation(name, args) ?? name`, exactly as the switch keyed. Most tools
// key on their own name; the six work verbs key on `<verb>:<operation>`, which
// is why the table is not simply the registry indexed by tool name.
//
// ── ONE MECHANISM PER TOOL, ALWAYS ──
// Roadmap non-negotiable #1 held by machine for the length of a three-sitting
// move, and still held now that the move is done: `handler-table.test.ts` reads
// the dispatcher's source for `case '…':` labels and asserts the set is EMPTY,
// so a new tool gets a handler here and never a case label bolted back on.
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
import { mediaHandlers } from './cat/media.js';
import { officeHandlers } from './cat/office.js';
import { webHandlers } from './cat/web.js';
import { canvasHandlers } from './cat/canvas.js';
import { hidHandlers } from './cat/hid.js';
import { credentialsHandlers } from './cat/credentials.js';
import { agentsHandlers } from './cat/agents.js';
import { fsHandlers } from './cat/fs.js';
import { sessionHandlers } from './cat/session.js';
import { metaHandlers } from './cat/meta.js';
import { googleHandlers } from './provider/google.js';
import { microsoftHandlers } from './provider/microsoft.js';
import { plaudHandlers } from './provider/plaud.js';
import { unifiedHandlers } from './provider/unified.js';

// ── THE TABLE IS BUILT ON FIRST USE, AND THAT IS A LOAD-ORDER FIX ──
// It used to be a module-level `new Map([...Object.entries(fsHandlers), …])`,
// which reads every category's export while THIS module is being evaluated.
// The toolbox's module graph has a real cycle through the registry —
//   cat/fs.ts → tools/util.ts → agent/canvas-view.ts → agent/model.ts →
//   tools/surface.ts → tools/gates.ts → tools/registry.ts → tools/handlers.ts
//   → cat/fs.ts
// — and an eager read makes the cycle FATAL for whichever module the graph is
// entered through: enter at `cat/fs.ts` (as `file-patch.test.ts` does now that
// it imports `executeFilePatch` from its real home) and `fsHandlers` is still
// in its temporal dead zone when this line runs, so `Object.entries(undefined)`
// throws before a single test collects.
//
// Deferring the read to first CALL removes the hazard for every entry point
// rather than for the one production happens to use — the same lazy-memoized
// shape `registry.ts` next door already has, for the same reason. It changes
// WHEN the table is assembled, never what is in it: `handler-table.test.ts`
// still reconciles the key set, and the census is unchanged at 268.
let TABLE: ReadonlyMap<string, ToolHandler> | null = null;

function table(): ReadonlyMap<string, ToolHandler> {
  if (TABLE) return TABLE;
  TABLE = new Map<string, ToolHandler>([
    ...Object.entries(recallHandlers),
    ...Object.entries(vaultHandlers),
    ...Object.entries(contactsHandlers),
    ...Object.entries(techniqueHandlers),
    ...Object.entries(healerHandlers),
    ...Object.entries(clockHandlers),
    ...Object.entries(platformHandlers),
    ...Object.entries(commsHandlers),
    ...Object.entries(trackerHandlers),
    ...Object.entries(mediaHandlers),
    ...Object.entries(officeHandlers),
    ...Object.entries(webHandlers),
    ...Object.entries(canvasHandlers),
    ...Object.entries(hidHandlers),
    ...Object.entries(credentialsHandlers),
    ...Object.entries(agentsHandlers),
    ...Object.entries(fsHandlers),
    ...Object.entries(sessionHandlers),
    ...Object.entries(metaHandlers),
    ...Object.entries(googleHandlers),
    ...Object.entries(microsoftHandlers),
    ...Object.entries(plaudHandlers),
    ...Object.entries(unifiedHandlers),
  ]);
  return TABLE;
}

/** The handler for this dispatch key, or `undefined` if no module serves it. */
export function handlerFor(dispatchKey: string): ToolHandler | undefined {
  return table().get(dispatchKey);
}

/** Every dispatch key this table serves. Consumed by the disjointness test and the registry. */
export function handledDispatchKeys(): readonly string[] {
  return [...table().keys()];
}
