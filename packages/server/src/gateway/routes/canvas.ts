// ════════════════════════════════════════
// Canvas (right-dock) routes.
//
// The canvas is a single durable surface. The agent opens things in it
// (show_canvas / auto-open on file write); the server persists the current
// canvas + an open/collapsed status (see agent/canvas-view.ts). The dashboard
// reads GET /api/canvas on mount so the canvas survives a refresh, a server
// restart, and follows the user across devices. POST /api/canvas/status lets the
// dashboard record a collapse (close → minimise to the edge handle) or a
// re-open, and the change is broadcast so every connected device stays in sync.
// ════════════════════════════════════════
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../server.js';
import { getPersistedCanvas, setCanvasStatus } from '../../agent/canvas-view.js';
import { broadcast } from '../ws.js';

export const canvasRouter = new Hono<AppEnv>();

// Current canvas spec + status (or null), for the dashboard to restore on mount.
canvasRouter.get('/', (c) => {
  return c.json({ ok: true, data: getPersistedCanvas() });
});

// The user collapsed the dock to the edge, or re-opened it from the edge handle.
// Persist the new status and broadcast it so the user's other devices follow.
canvasRouter.post('/status', async (c) => {
  const { status } = z
    .object({ status: z.enum(['open', 'collapsed']) })
    .parse(await c.req.json());
  setCanvasStatus(status);
  const cur = getPersistedCanvas();
  if (status === 'collapsed') {
    broadcast({ type: 'dock:collapse' });
  } else if (status === 'open' && cur) {
    // Re-broadcast the open so OTHER connected devices open the same canvas.
    const s = cur.state;
    broadcast({
      type: 'dock:open',
      data: { kind: s.kind, title: s.title, html: s.html, url: s.url, path: s.path, sourceUrl: s.sourceUrl },
    });
  }
  return c.json({ ok: true, data: cur });
});
