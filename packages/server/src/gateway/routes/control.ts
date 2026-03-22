// ════════════════════════════════════════
// System Control Routes (Phase 5A)
// Dashboard endpoints for manual system control testing
// ════════════════════════════════════════

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../server.js';
import { mouseClick, mouseMove, keyboardType, screenRead, applescriptRun } from '../../agent/system-control.js';
import { getPrimaryAgentId } from '../../config/platform.js';

export const controlRouter = new Hono<AppEnv>();

controlRouter.post('/mouse-click', async (c) => {
  const body = z.object({ x: z.number(), y: z.number(), click_type: z.enum(['left', 'right', 'double']).optional() }).parse(await c.req.json());
  const result = mouseClick(getPrimaryAgentId(), body);
  return c.json({ ok: true, data: { result } });
});

controlRouter.post('/mouse-move', async (c) => {
  const body = z.object({ x: z.number(), y: z.number() }).parse(await c.req.json());
  const result = mouseMove(getPrimaryAgentId(), body);
  return c.json({ ok: true, data: { result } });
});

controlRouter.post('/keyboard-type', async (c) => {
  const body = z.object({ text: z.string().optional(), key_combo: z.string().optional() }).parse(await c.req.json());
  const result = keyboardType(getPrimaryAgentId(), body);
  return c.json({ ok: true, data: { result } });
});

controlRouter.post('/screen-read', async (c) => {
  const body = z.object({
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
    query: z.string().optional(),
  }).parse(await c.req.json());
  const result = await screenRead(getPrimaryAgentId(), body);
  return c.json({ ok: true, data: { description: result } });
});

controlRouter.post('/applescript', async (c) => {
  const body = z.object({ script: z.string() }).parse(await c.req.json());
  const result = applescriptRun(getPrimaryAgentId(), body);
  return c.json({ ok: true, data: { result } });
});
