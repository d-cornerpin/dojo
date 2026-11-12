// Credentials routes for the Memory page's Credentials tab. The list returns metadata only;
// /reveal returns the decrypted value. Every read, by agent or dashboard, is logged in the store.

import { Hono } from 'hono';
import type { AppEnv } from '../server.js';
import { mergeObjectPatch } from '../../db/patch.js';
import {
  listCredentials,
  getCredentialById,
  addCredential,
  updateCredential,
  deleteCredentialById,
} from '../../credentials/store.js';
import { routeFailure } from './route-failure.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('credentials-routes');

export const credentialsRouter = new Hono<AppEnv>();

// Nothing from this router may be kept by a browser, proxy or cache: the reveal carries a decrypted
// secret in its body. Set after the handler so every response (errors included) carries it.
credentialsRouter.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
  c.res.headers.set('Pragma', 'no-cache');
});

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
    return routeFailure(c, logger, err, { status: 500 });
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

  // This is a PATCH: a field the caller did not mention keeps its stored value and an explicit
  // `null` removes it. The agent tool replaces the whole blob; the HTTP verb is the partial one,
  // so the merge belongs here.
  const current = getCredentialById(id, null);
  if (!current) return c.json({ ok: false, error: 'Credential not found.' }, 404);
  const merged = mergeObjectPatch(current.credentials, credentials);

  // `overwrite: true` is stated here, not exempted in the store: this route is the owner editing a row
  // in their own Credentials tab, so the click is the confirmation the flag exists to capture.
  const result = updateCredential(existing.serviceName, merged, description, null, { overwrite: true });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 404);
  return c.json({ ok: true, data: { id: result.record.id, service_name: result.record.serviceName } });
});

credentialsRouter.delete('/:id', (c) => {
  const id = c.req.param('id');
  // `confirm: true` is stated here, not exempted in the store: the owner pressing delete in their
  // own Credentials tab is the confirmation the flag exists to capture.
  const result = deleteCredentialById(id, null, { confirm: true });
  if (!result.ok) return c.json({ ok: false, error: result.error ?? 'Delete failed.' }, 404);
  return c.json({ ok: true, data: { deleted: true } });
});
