// ════════════════════════════════════════
// GET /api/agents/:id/prompt-cost (K36): the agent's standing instruction piece by piece, biggest
// first, with tokens, share and growth, the lanes the allocator admitted, and the tool head's
// tokens. A report the owner reads where he reads everything else; nothing here limits anything.
// ════════════════════════════════════════

import { Hono } from 'hono';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { promptCostReport } from '../../memory/prompt-sections.js';
import { measureAgentToolPayloadTokens } from '../../tools/tool-docs.js';
import { noteRouteFailure } from './route-failure.js';

const logger = createLogger('prompt-cost-routes');
export const promptCostRouter = new Hono();

promptCostRouter.get('/:id/prompt-cost', async (c) => {
  const id = c.req.param('id');
  try {
    if (!getDb().prepare('SELECT 1 FROM agents WHERE id = ?').get(id)) {
      return c.json({ ok: false, error: 'Agent not found' }, 404);
    }
    const report = promptCostReport(id);
    return c.json({ ok: true, data: { ...report, toolHeadTokens: await measureAgentToolPayloadTokens(id) } });
  } catch (err) {
    noteRouteFailure(c, logger, err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
