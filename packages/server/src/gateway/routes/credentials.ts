// ════════════════════════════════════════
// Credentials Routes
// Powers the "Credentials" tab on the Memory page.
// Default list endpoint returns metadata only (no values). Separate
// /reveal endpoint returns the decrypted value for the dashboard "Show"
// button. Every read - via the agent OR via the dashboard - is logged
// in the credentials store.
// ════════════════════════════════════════

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import {
  listCredentials,
  getCredentialById,
  addCredential,
  updateCredential,
  deleteCredentialById,
} from '../../credentials/store.js';

export const credentialsRouter = new Hono<AppEnv>();

credentialsRouter.get('/', (c) => {
  const records = listCredentials().map(r => ({
    id: r.id,
    service_name: r.serviceName,
    description: r.description,
    created_by_agent_id: r.createdByAgentId,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    last_accessed_at: r.lastAccessedAt,
    last_accessed_by_agent_id: r.lastAccessedByAgentId,
    access_count: r.accessCount,
  }));
  return c.json({ ok: true, data: { count: records.length, credentials: records } });
});

// Reveal the decrypted value. Separate endpoint so the regular list
// stays safe by default. Dashboard "Show" button on a row hits this.
credentialsRouter.get('/:id/reveal', (c) => {
  const id = c.req.param('id');
  try {
    const record = getCredentialById(id, null);
    if (!record) return c.json({ ok: false, error: 'Credential not found.' }, 404);
    return c.json({
      ok: true,
      data: {
        id: record.id,
        service_name: record.serviceName,
        description: record.description,
        credentials: record.credentials,
      },
    });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

credentialsRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ ok: false, error: 'Body required.' }, 400);
  }
  const serviceName = (body.service_name as string | undefined)?.trim();
  const credentials = body.credentials as Record<string, unknown> | undefined;
  const description = (body.description as string | undefined) ?? null;
  if (!serviceName) return c.json({ ok: false, error: 'service_name is required.' }, 400);
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    return c.json({ ok: false, error: 'credentials must be an object.' }, 400);
  }
  const result = addCredential(serviceName, credentials, description, null);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 409);
  return c.json({
    ok: true,
    data: {
      id: result.record.id,
      service_name: result.record.serviceName,
      description: result.record.description,
      created_at: result.record.createdAt,
    },
  });
});

credentialsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ ok: false, error: 'Body required.' }, 400);
  }
  // Resolve id -> service_name to use the store helper.
  const existing = listCredentials().find(r => r.id === id);
  if (!existing) return c.json({ ok: false, error: 'Credential not found.' }, 404);

  const credentials = body.credentials as Record<string, unknown> | undefined;
  const description = body.description as string | undefined;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    return c.json({ ok: false, error: 'credentials must be an object.' }, 400);
  }
  const result = updateCredential(existing.serviceName, credentials, description, null);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 404);
  return c.json({ ok: true, data: { id: result.record.id, service_name: result.record.serviceName } });
});

credentialsRouter.delete('/:id', (c) => {
  const id = c.req.param('id');
  const result = deleteCredentialById(id, null);
  if (!result.ok) return c.json({ ok: false, error: result.error ?? 'Delete failed.' }, 404);
  return c.json({ ok: true, data: { deleted: true } });
});
