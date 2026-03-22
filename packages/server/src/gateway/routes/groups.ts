// ════════════════════════════════════════
// Agent Groups API Routes (Phase 6)
// ════════════════════════════════════════

import { Hono } from 'hono';
import { z } from 'zod';
import { createGroup, getGroups, getGroupDetail, updateGroup, deleteGroup, assignAgentToGroup, SYSTEM_GROUP_ID } from '../../agent/groups.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('routes:groups');

export const groupsRouter = new Hono();

// POST / — create a group
groupsRouter.post('/', async (c) => {
  const body = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    color: z.string().optional(),
  }).parse(await c.req.json());

  const group = createGroup(body.name, body.description ?? null, 'dashboard', body.color);
  return c.json({ ok: true, data: group }, 201);
});

// GET / — list all groups
groupsRouter.get('/', (c) => {
  return c.json({ ok: true, data: getGroups() });
});

// GET /:id — group detail with members
groupsRouter.get('/:id', (c) => {
  const id = c.req.param('id');
  const group = getGroupDetail(id);
  if (!group) return c.json({ ok: false, error: 'Group not found' }, 404);
  return c.json({ ok: true, data: group });
});

// PUT /:id — update group
groupsRouter.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    color: z.string().optional(),
  }).parse(await c.req.json());

  const updated = updateGroup(id, body);
  if (!updated) return c.json({ ok: false, error: 'Group not found' }, 404);
  return c.json({ ok: true, data: getGroupDetail(id) });
});

// DELETE /:id — delete group
groupsRouter.delete('/:id', (c) => {
  const id = c.req.param('id');
  if (id === SYSTEM_GROUP_ID) return c.json({ ok: false, error: 'System group cannot be deleted' }, 403);
  const deleted = deleteGroup(id);
  if (!deleted) return c.json({ ok: false, error: 'Group not found' }, 404);
  return c.json({ ok: true, data: { deleted: id } });
});

// PUT /agents/:agentId/group — assign agent to group
groupsRouter.put('/agents/:agentId/group', async (c) => {
  const agentId = c.req.param('agentId');
  const body = z.object({
    group_id: z.string().nullable(),
  }).parse(await c.req.json());

  const result = assignAgentToGroup(agentId, body.group_id);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 403);
  return c.json({ ok: true, data: { agentId, groupId: body.group_id } });
});
