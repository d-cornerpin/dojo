// ════════════════════════════════════════
// Canvas (right-dock) routes.
//
// The canvas is a durable surface PER AGENT. The agent opens things in its own
// slot (canvas_render / auto-open on file write); the server persists each
// agent's current canvas + open/collapsed status (see agent/canvas-view.ts). The
// dashboard reads GET /api/canvas?agentId=<viewed> on mount (and on agent switch)
// so the canvas survives a refresh, a server restart, and follows the user across
// devices. POST /api/canvas/status carries the viewed agentId so a collapse
// (close → minimise to the edge handle) or a re-open updates THAT agent's slot,
// and the change is broadcast (stamped with agentId) so every connected device
// stays in sync.
// ════════════════════════════════════════
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../server.js';
import { getPersistedCanvas, setCanvasStatus } from '../../agent/canvas-view.js';
import { broadcast } from '../ws.js';

export const canvasRouter = new Hono<AppEnv>();

// The viewed agent's canvas spec + status (or null), for the dashboard to restore
// on mount and on agent switch. No agentId -> nothing to show (dock stays closed).
canvasRouter.get('/', (c) => {
  const agentId = c.req.query('agentId');
  if (!agentId) return c.json({ ok: true, data: null });
  return c.json({ ok: true, data: getPersistedCanvas(agentId) });
});

// The user collapsed the dock to the edge, or re-opened it from the edge handle,
// while viewing a given agent. Persist the new status on THAT agent's slot and
// broadcast it (stamped with agentId) so the user's other devices follow.
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
