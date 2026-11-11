// One map from dispatch key to handler, from the `cat/` and `provider/` modules; the
// only place a tool name becomes a function call. Key: `workOperation(name, args) ?? name`:
// the six work verbs key on `<verb>:<operation>`, every other tool on its own name.
// A category module imports leaves only (types, pagination, util, surface, definitions,
// brokers, stores) and never the executor `agent/tools/index.ts`; that edge would close
// a cycle through this module, so a category needing something from the executor moves
// it to a leaf first. `handler-table.test.ts` asserts the dispatcher (`index.ts`) has no `case` labels.

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
import { reportHandlers } from './cat/report.js';
import { resultReadHandlers } from './cat/result-read.js';
import { inspectHandlers } from './cat/inspect.js';
import { googleHandlers } from './provider/google.js';
import { microsoftHandlers } from './provider/microsoft.js';
import { plaudHandlers } from './provider/plaud.js';
import { unifiedHandlers } from './provider/unified.js';

// Built lazily on first call; the graph has a real cycle: cat/fs.ts → tools/util.ts →
// agent/canvas-view.ts → agent/model.ts → tools/surface.ts → tools/gates.ts →
// tools/registry.ts → handlers.ts → cat/fs.ts. Reading every category export eagerly
// hits their temporal dead zone for some entry points; deferring is safe for all of them.
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
    ...Object.entries(reportHandlers),
    ...Object.entries(resultReadHandlers),
    ...Object.entries(inspectHandlers),
    ...Object.entries(googleHandlers),
    ...Object.entries(microsoftHandlers),
    ...Object.entries(plaudHandlers),
    ...Object.entries(unifiedHandlers),
  ]);
  return TABLE;
}

export function handlerFor(dispatchKey: string): ToolHandler | undefined {
  return table().get(dispatchKey);
}

export function handledDispatchKeys(): readonly string[] {
  return [...table().keys()];
}
