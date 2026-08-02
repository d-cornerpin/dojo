// ════════════════════════════════════════
// Contacts Routes (v2.9.16)
// Powers the "Contacts" tab on the Memory/Vault page. Same agent-facing
// store the contact_* tools write to.
// ════════════════════════════════════════

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import {
  listContacts,
  searchContacts,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  describeContacts,
  countContacts,
  type ContactInput,
} from '../../contacts/store.js';
import { routeFailure } from './route-failure.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('contacts-routes');

export const contactsRouter = new Hono<AppEnv>();

function serialize(r: ReturnType<typeof getContactById>) {
  if (!r) return null;
  return {
    id: r.id,
    display_name: r.displayName,
    preferred_name: r.preferredName,
    emails: r.emails,
    phones: r.phones,
    imessage_handles: r.imessageHandles,
    company: r.company,
    role: r.role,
    notes: r.notes,
    tags: r.tags,
    created_by_agent_id: r.createdByAgentId,
    last_updated_by_agent_id: r.lastUpdatedByAgentId,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

contactsRouter.get('/', (c) => {
  const q = c.req.query('q') ?? '';
  const sortBy = (c.req.query('sort_by') as 'name' | 'company' | 'updated' | undefined) ?? 'updated';
  const sortDir = (c.req.query('sort_dir') as 'asc' | 'desc' | undefined) ?? (sortBy === 'updated' ? 'desc' : 'asc');
  const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') ?? 50)));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const trimmedQ = q.trim();
  const records = trimmedQ
    ? searchContacts(trimmedQ, limit, offset)
    : listContacts({ limit, offset, sortBy, sortDir });
  const total = countContacts(trimmedQ || undefined);
  return c.json({ ok: true, data: { count: records.length, total, contacts: records.map(serialize) } });
});

contactsRouter.get('/describe', (c) => {
  return c.json({ ok: true, data: describeContacts() });
});

contactsRouter.get('/:id', (c) => {
  const id = c.req.param('id');
  const record = getContactById(id);
  if (!record) return c.json({ ok: false, error: 'Contact not found.' }, 404);
  return c.json({ ok: true, data: serialize(record) });
});

function parseBodyToInput(body: Record<string, unknown>): ContactInput {
  const asArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  return {
    displayName: typeof body.display_name === 'string' ? body.display_name : undefined,
    preferredName: typeof body.preferred_name === 'string' ? body.preferred_name : undefined,
    emails: asArr(body.emails),
    phones: asArr(body.phones),
    imessageHandles: asArr(body.imessage_handles),
    company: typeof body.company === 'string' ? body.company : undefined,
    role: typeof body.role === 'string' ? body.role : undefined,
    notes: typeof body.notes === 'string' ? body.notes : undefined,
    tags: asArr(body.tags),
  };
}

contactsRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ ok: false, error: 'Body required.' }, 400);
  const input = parseBodyToInput(body as Record<string, unknown>);
  if (!input.displayName) return c.json({ ok: false, error: 'display_name is required.' }, 400);
  try {
    const created = createContact(input, null);
    return c.json({ ok: true, data: serialize(created) });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 400 });
  }
});

contactsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ ok: false, error: 'Body required.' }, 400);
  // Optimistic locking: dashboard sends the updated_at it saw when it
  // opened the edit drawer (via If-Match header OR a body field).
  // If the contact has changed since (typically an agent appended an
  // observation), return 409 with the current record so the UI can
  // surface the conflict and let the owner decide. Agent-side tools
  // (contact_remember / contact_update) skip this check - they're
  // authoritative writers, not stale UI clients.
  const expectedUpdatedAt = c.req.header('If-Match') ?? (typeof (body as Record<string, unknown>).expected_updated_at === 'string' ? (body as Record<string, unknown>).expected_updated_at as string : undefined);
  if (expectedUpdatedAt) {
    const current = getContactById(id);
    if (!current) return c.json({ ok: false, error: 'Contact not found.' }, 404);
    if (current.updatedAt !== expectedUpdatedAt) {
      return c.json({
        ok: false,
        error: 'Contact changed since you opened it. Reload to see the current state, then re-apply your edits.',
        data: { code: 'conflict', current: serialize(current) },
      }, 409);
    }
  }
  const updated = updateContact(id, parseBodyToInput(body as Record<string, unknown>), null, 'replace');
  if (!updated) return c.json({ ok: false, error: 'Contact not found.' }, 404);
  return c.json({ ok: true, data: serialize(updated) });
});

contactsRouter.delete('/:id', (c) => {
  const id = c.req.param('id');
  const ok = deleteContact(id);
  if (!ok) return c.json({ ok: false, error: 'Contact not found.' }, 404);
  return c.json({ ok: true, data: { deleted: true } });
});
