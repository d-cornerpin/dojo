import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../ws.js';
import { getHealerConfig, setHealerConfig, scheduleHealingCycle, runHealingCycle, sendHealerReport, getHealerLogContent } from '../../healer/healer-agent.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import { getAgentRuntime } from '../../agent/runtime.js';

const logger = createLogger('healer-routes');

export const healerRouter = new Hono();

// GET /config — get healer settings
healerRouter.get('/config', (c) => {
  const config = getHealerConfig();
  return c.json({ ok: true, data: config });
});

// POST /config — update healer settings
healerRouter.post('/config', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ ok: false, error: 'Invalid request body' }, 400);

  setHealerConfig({
    modelId: body.modelId,
    healerTime: body.healerTime,
    healerMode: body.healerMode,
  });

  // Keep agents.model_id in sync so the agent card reflects the same value
  if (body.modelId) {
    const { getHealerAgentId } = await import('../../config/platform.js');
    const db = (await import('../../db/connection.js')).getDb();
    db.prepare("UPDATE agents SET model_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(body.modelId, getHealerAgentId());
  }

  // Reschedule with new config
  scheduleHealingCycle();

  return c.json({ ok: true, data: getHealerConfig() });
});

// GET /proposals — list pending/recent proposals
healerRouter.get('/proposals', (c) => {
  const db = getDb();
  const proposals = db.prepare(`
    SELECT * FROM healer_proposals
    ORDER BY
      CASE status WHEN 'pending' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 50
  `).all();
  return c.json({ ok: true, data: proposals });
});

// POST /proposals/:id — approve or deny a proposal
healerRouter.post('/proposals/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || !body.action) return c.json({ ok: false, error: 'action is required' }, 400);

  const db = getDb();
  const proposal = db.prepare('SELECT * FROM healer_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!proposal) return c.json({ ok: false, error: 'Proposal not found' }, 404);
  if (proposal.status !== 'pending') return c.json({ ok: false, error: `Proposal is already ${proposal.status}` }, 400);

  if (body.action === 'approve') {
    db.prepare("UPDATE healer_proposals SET status = 'approved', resolved_at = datetime('now') WHERE id = ?").run(id);
    logger.info('Healer proposal approved', { proposalId: id, title: proposal.title });
    return c.json({ ok: true, data: { status: 'approved' } });
  }

  if (body.action === 'deny') {
    const note = body.note as string | undefined;
    db.prepare("UPDATE healer_proposals SET status = 'denied', user_note = ?, resolved_at = datetime('now') WHERE id = ?").run(note ?? null, id);

    // Send denial + user note to primary agent for discussion
    try {
      const primaryId = getPrimaryAgentId();
      const msgId = uuidv4();
      const content = [
        '[SOURCE: HEALER PROPOSAL DENIED — the user denied a proposed fix and may want to discuss alternatives]',
        '',
        `Denied proposal: ${proposal.title}`,
        `Reason from Healer: ${proposal.description}`,
        `Proposed fix: ${proposal.proposed_fix}`,
        note ? `User's note: "${note}"` : 'User did not provide a note.',
        '',
        'Please discuss this with the user and figure out the right solution.',
        'If you resolve it, save the outcome to the vault so the Healer learns for next time.',
      ].join('\n');

      db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'user', ?, datetime('now'))`)
        .run(msgId, primaryId, content);

      broadcast({
        type: 'chat:message',
        agentId: primaryId,
        message: { id: msgId, agentId: primaryId, role: 'user' as const, content, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
      });

      // Trigger primary agent to process the denied proposal
      const runtime = getAgentRuntime();
      runtime.handleMessage(primaryId, content).catch(err => {
        logger.error('Failed to notify primary agent of denied proposal', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      logger.error('Failed to send denial to primary agent', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('Healer proposal denied', { proposalId: id, title: proposal.title, note });
    return c.json({ ok: true, data: { status: 'denied' } });
  }

  return c.json({ ok: false, error: 'action must be "approve" or "deny"' }, 400);
});

// GET /actions — list recent auto-fix actions
healerRouter.get('/actions', (c) => {
  const db = getDb();
  const actions = db.prepare('SELECT * FROM healer_actions ORDER BY created_at DESC LIMIT 50').all();
  return c.json({ ok: true, data: actions });
});

// GET /diagnostics — get latest diagnostic report
healerRouter.get('/diagnostics', (c) => {
  const db = getDb();
  const latest = db.prepare('SELECT * FROM healer_diagnostics ORDER BY created_at DESC LIMIT 1').get();
  return c.json({ ok: true, data: latest ?? null });
});

// POST /run — trigger an immediate healing cycle (for testing)
healerRouter.post('/run', async (c) => {
  try {
    const result = await runHealingCycle();
    return c.json({ ok: true, data: result });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// GET /report — get the current healer log content
healerRouter.get('/report', (c) => {
  const content = getHealerLogContent();
  return c.json({ ok: true, data: { content, hasContent: content !== null } });
});

// POST /report/send — email the healer report and archive the log
healerRouter.post('/report/send', async (c) => {
  try {
    const result = await sendHealerReport();
    if (!result.ok) {
      const status = result.error === 'NO_EMAIL_CONFIGURED' ? 400 : 500;
      return c.json({ ok: false, error: result.error }, status);
    }
    return c.json({ ok: true, data: { message: 'Report sent and archived' } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
