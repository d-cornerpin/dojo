// ════════════════════════════════════════
// Technique API Routes
// ════════════════════════════════════════

import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../logger.js';
import {
  createTechnique,
  getTechnique,
  getTechniqueDetail,
  listTechniques,
  updateTechnique,
  updateTechniqueInstructions,
  publishTechnique,
  deleteTechnique,
  recordTechniqueUsage,
} from '../../techniques/store.js';
import { getVersions, getVersion, restoreVersion, getUsage } from '../../techniques/versioning.js';
import { clearTrainerSession } from '../../techniques/trainer-agent.js';

const logger = createLogger('technique-routes');

const techniquesRouter = new Hono();

// GET / — list techniques
techniquesRouter.get('/', (c) => {
  const state = c.req.query('state') ?? undefined;
  const tag = c.req.query('tag') ?? undefined;
  const search = c.req.query('search') ?? undefined;

  const techniques = listTechniques({ state, tag, search, includeDrafts: true });
  return c.json({ ok: true, data: techniques });
});

// GET /:id — technique detail
techniquesRouter.get('/:id', (c) => {
  const id = c.req.param('id');
  const detail = getTechniqueDetail(id);
  if (!detail) return c.json({ ok: false, error: 'Technique not found' }, 404);
  return c.json({ ok: true, data: detail });
});

// POST / — create technique
techniquesRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.name || !body?.displayName || !body?.instructions) {
    return c.json({ ok: false, error: 'name, displayName, and instructions are required' }, 400);
  }

  try {
    const technique = createTechnique({
      name: body.name,
      displayName: body.displayName,
      description: body.description ?? '',
      instructions: body.instructions,
      tags: body.tags ?? [],
      files: body.files,
      publish: body.publish ?? false,
      authorAgentId: body.authorAgentId,
      authorAgentName: body.authorAgentName,
    });
    return c.json({ ok: true, data: technique }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 400);
  }
});

// PUT /:id — update technique metadata
techniquesRouter.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ ok: false, error: 'Request body required' }, 400);

  const technique = getTechnique(id);
  if (!technique) return c.json({ ok: false, error: 'Technique not found' }, 404);

  const updated = updateTechnique(id, {
    description: body.description,
    tags: body.tags,
    enabled: body.enabled,
    state: body.state,
    buildProjectId: body.buildProjectId,
    buildSquadId: body.buildSquadId,
  });

  return c.json({ ok: true, data: updated });
});

// PUT /:id/instructions — update TECHNIQUE.md
techniquesRouter.put('/:id/instructions', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body?.content) return c.json({ ok: false, error: 'content is required' }, 400);

  const technique = getTechnique(id);
  if (!technique) return c.json({ ok: false, error: 'Technique not found' }, 404);

  const updated = updateTechniqueInstructions(id, body.content, body.changeSummary ?? 'Updated from dashboard', 'dashboard');
  return c.json({ ok: true, data: updated });
});

// POST /:id/publish — publish a technique
techniquesRouter.post('/:id/publish', (c) => {
  const id = c.req.param('id');
  const published = publishTechnique(id);
  if (!published) return c.json({ ok: false, error: 'Technique not found' }, 404);
  return c.json({ ok: true, data: published });
});

// DELETE /:id — delete technique
techniquesRouter.delete('/:id', (c) => {
  const id = c.req.param('id');
  const deleted = deleteTechnique(id);
  if (!deleted) return c.json({ ok: false, error: 'Technique not found' }, 404);
  return c.json({ ok: true, data: { id } });
});

// GET /:id/versions — list versions
techniquesRouter.get('/:id/versions', (c) => {
  const id = c.req.param('id');
  const versions = getVersions(id);
  return c.json({ ok: true, data: versions });
});

// GET /:id/versions/:versionId — get specific version
techniquesRouter.get('/:id/versions/:versionId', (c) => {
  const versionId = c.req.param('versionId');
  const version = getVersion(versionId);
  if (!version) return c.json({ ok: false, error: 'Version not found' }, 404);
  return c.json({ ok: true, data: version });
});

// POST /:id/versions/:versionId/restore — restore a version
techniquesRouter.post('/:id/versions/:versionId/restore', (c) => {
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  const restored = restoreVersion(id, versionId);
  if (!restored) return c.json({ ok: false, error: 'Failed to restore version' }, 400);
  return c.json({ ok: true, data: { restored: true } });
});

// GET /:id/usage — usage log
techniquesRouter.get('/:id/usage', (c) => {
  const id = c.req.param('id');
  const usage = getUsage(id);
  return c.json({ ok: true, data: usage });
});

// GET /:id/files — file tree
techniquesRouter.get('/:id/files', (c) => {
  const id = c.req.param('id');
  const technique = getTechnique(id);
  if (!technique) return c.json({ ok: false, error: 'Technique not found' }, 404);

  const detail = getTechniqueDetail(id);
  return c.json({ ok: true, data: detail?.files ?? [] });
});

// GET /:id/files/* — read a file
techniquesRouter.get('/:id/files/*', (c) => {
  const id = c.req.param('id');
  const technique = getTechnique(id);
  if (!technique) return c.json({ ok: false, error: 'Technique not found' }, 404);

  const filePath = c.req.path.replace(`/api/techniques/${id}/files/`, '');
  const fullPath = path.join(technique.directoryPath, filePath);

  if (!fs.existsSync(fullPath)) return c.json({ ok: false, error: 'File not found' }, 404);

  const content = fs.readFileSync(fullPath, 'utf-8');
  return c.json({ ok: true, data: { path: filePath, content } });
});

// PUT /:id/files/* — write a file
techniquesRouter.put('/:id/files/*', async (c) => {
  const id = c.req.param('id');
  const technique = getTechnique(id);
  if (!technique) return c.json({ ok: false, error: 'Technique not found' }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body?.content && body?.content !== '') return c.json({ ok: false, error: 'content is required' }, 400);

  const filePath = c.req.path.replace(`/api/techniques/${id}/files/`, '');
  const fullPath = path.join(technique.directoryPath, filePath);

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, body.content, 'utf-8');

  return c.json({ ok: true, data: { path: filePath } });
});

// DELETE /:id/files/* — delete a file
techniquesRouter.delete('/:id/files/*', (c) => {
  const id = c.req.param('id');
  const technique = getTechnique(id);
  if (!technique) return c.json({ ok: false, error: 'Technique not found' }, 404);

  const filePath = c.req.path.replace(`/api/techniques/${id}/files/`, '');
  const fullPath = path.join(technique.directoryPath, filePath);

  if (!fs.existsSync(fullPath)) return c.json({ ok: false, error: 'File not found' }, 404);

  fs.unlinkSync(fullPath);
  return c.json({ ok: true, data: { path: filePath } });
});

// POST /clear-session — clear trainer agent messages for a fresh session
techniquesRouter.post('/clear-session', (c) => {
  try {
    clearTrainerSession();
    return c.json({ ok: true, data: { cleared: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to clear trainer session', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { techniquesRouter };
