// Canvas (right-dock) routes: each agent has its own persisted canvas and open/collapsed status,
// so the dashboard restores it on mount and every connected device stays in sync.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../server.js';
import { getPersistedCanvas, setCanvasStatus } from '../../agent/canvas-state.js';
import { broadcast } from '../ws.js';

export const canvasRouter = new Hono<AppEnv>();

// The viewed agent's canvas spec and status (or null); no agentId means nothing to show.
canvasRouter.get('/', (c) => {
  const agentId = c.req.query('agentId');
  if (!agentId) return c.json({ ok: true, data: null });
  return c.json({ ok: true, data: getPersistedCanvas(agentId) });
});

// Persist collapse/open on THAT agent's slot and broadcast it so other devices follow.
canvasRouter.post('/status', async (c) => {
  const { agentId, status } = z
    .object({ agentId: z.string().min(1), status: z.enum(['open', 'collapsed']) })
    .parse(await c.req.json());
  setCanvasStatus(agentId, status);
  const cur = getPersistedCanvas(agentId);
  if (status === 'collapsed') {
    broadcast({ type: 'dock:collapse', agentId });
  } else if (status === 'open' && cur) {
    // Re-broadcast the open so OTHER connected devices open the same canvas.
    const s = cur.state;
    broadcast({
      type: 'dock:open',
      agentId,
      data: { kind: s.kind, title: s.title, html: s.html, url: s.url, path: s.path, sourceUrl: s.sourceUrl },
    });
  }
  return c.json({ ok: true, data: cur });
});
