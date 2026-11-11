// `dojo_inspect`: the eight views, read-only by construction; the grant is checked before this runs.

import type { ToolHandlerMap } from '../handler.js';
import { dojoInspect } from '../../../inspect/index.js';

export const inspectHandlers: ToolHandlerMap = {
  async dojo_inspect({ agentId, args }) {
    return { content: await dojoInspect(args, agentId), isError: false };
  },
};
