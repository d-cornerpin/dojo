// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect C1 — the handler for `dojo_inspect`: the one door into the eight views.
//
// Read-only by construction (every view reads through the read-only connection or GitHub), so the
// answer is never an error the agent has to interpret: a view that cannot answer says so in a
// plain sentence. The grant (main agent + Healer, others by explicit grant) is checked before this
// runs: the surface strip and the executor's gate row, both asking `inspect/grant.ts`.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { ToolHandlerMap } from '../handler.js';
import { dojoInspect } from '../../../inspect/index.js';

export const inspectHandlers: ToolHandlerMap = {
  async dojo_inspect({ agentId, args }) {
    return { content: await dojoInspect(args, agentId), isError: false };
  },
};
