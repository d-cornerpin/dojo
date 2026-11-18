import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../ws.js';
import { getHealerConfig, setHealerConfig, scheduleHealingCycle, runHealingCycle, sendHealerReport, HEALER_MODES } from '../../healer/healer-agent.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import { getAgentRuntime } from '../../agent/runtime.js';
import { insertEngineEventIfAbsent } from '../../memory/message-store.js';
import { grantApprovalForSignature } from '../../agent/destructive-gate.js';
import { routeFailure } from './route-failure.js';
import { refuseAgentModel } from '../../agent/main-model-floor.js';
import { refuseBadClockTime } from '../../config/clock-time.js';

const logger = createLogger('healer-routes');

export const healerRouter = new Hono();

// GET /config (get healer settings)
healerRouter.get('/config', (c) => {
  const config = getHealerConfig();
  return c.json({ ok: true, data: config });
});

// POST /config (update healer settings)
healerRouter.post('/config', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ ok: false, error: 'Invalid request body' }, 400);

  // Refuse before any write: memory fit first, then the 32K main-model floor, so the refusal names the true reason.
  const { getHealerAgentId } = await import('../../config/platform.js');
  const newModel = typeof body.modelId === 'string' ? body.modelId : null;
  const current = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(getHealerAgentId()) as { model_id: string | null } | undefined)?.model_id;
  const refused = await refuseAgentModel(newModel, current);
  if (refused) return c.json({ ok: false, error: refused }, 400);

  const badTime = body.healerTime === undefined ? null : refuseBadClockTime(body.healerTime);
  if (badTime) return c.json({ ok: false, error: badTime }, 400);

  // The nightly healing run reads the mode back by exact word, so refuse any other value (a
  // stray word or a non-text one) here, before any write, instead of storing one it reads as neither.
  if (body.healerMode !== undefined && !HEALER_MODES.includes(body.healerMode)) {
    return c.json({ ok: false, error: `Healer mode must be one of: ${HEALER_MODES.join(', ')}.` }, 400);
  }
  if (body.modelId !== undefined && typeof body.modelId !== 'string') {
    return c.json({ ok: false, error: 'Model id must be text.' }, 400);
  }

  setHealerConfig({
    modelId: body.modelId,
    healerTime: body.healerTime,
    healerMode: body.healerMode,
  });

  // Keep agents.model_id in sync so the agent card reflects the same value
  if (body.modelId) {
    const db = (await import('../../db/connection.js')).getDb();
    db.prepare("UPDATE agents SET model_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(body.modelId, getHealerAgentId());
  }

  // Reschedule with new config
  scheduleHealingCycle();

  return c.json({ ok: true, data: getHealerConfig() });
});

// GET /proposals (pending ones always, resolved ones only from the last 48h; older rows stay in the DB)
healerRouter.get('/proposals', (c) => {
  const db = getDb();
  const proposals = db.prepare(`
    SELECT * FROM healer_proposals
    WHERE status = 'pending'
       OR datetime(COALESCE(resolved_at, created_at)) >= datetime('now', '-48 hours')
    ORDER BY
      CASE status WHEN 'pending' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 50
  `).all();
  return c.json({ ok: true, data: proposals });
});

// POST /proposals/:id (approve or deny a proposal)
healerRouter.post('/proposals/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || !body.action) return c.json({ ok: false, error: 'action is required' }, 400);

  const result = resolveHealerProposal({
    id,
    action: body.action,
    note: (body.note as string | undefined) ?? null,
  });
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, result.code === 'not_found' ? 404 : 400);
  }
  return c.json({ ok: true, data: { status: result.status } });
});

// GET /actions (auto-fix actions from the last 48 hours; older rows stay in the DB)
healerRouter.get('/actions', (c) => {
  const db = getDb();
  const actions = db.prepare(`
    SELECT * FROM healer_actions
    WHERE datetime(created_at) >= datetime('now', '-48 hours')
    ORDER BY created_at DESC
    LIMIT 50
  `).all();
  return c.json({ ok: true, data: actions });
});

// GET /diagnostics (latest diagnostic report)
healerRouter.get('/diagnostics', (c) => {
  const db = getDb();
  const latest = db.prepare('SELECT * FROM healer_diagnostics ORDER BY created_at DESC LIMIT 1').get();
  return c.json({ ok: true, data: latest ?? null });
});

// POST /run (trigger an immediate healing cycle, for testing)
healerRouter.post('/run', async (c) => {
  try {
    const result = await runHealingCycle();
    return c.json({ ok: true, data: result });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// POST /report/send (email the healer report and archive the log)
healerRouter.post('/report/send', async (c) => {
  try {
    const result = await sendHealerReport();
    if (!result.ok) {
      const status = (result.error === 'NO_EMAIL_CONFIGURED' || result.error === 'NO_OWNER_MAILBOX') ? 400 : 500;
      return c.json({ ok: false, error: result.error }, status);
    }
    return c.json({ ok: true, data: { message: 'Report sent and archived' } });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// Shared proposal-resolution core: the dashboard route (POST /proposals/:id) and the iMessage
// approve/deny lane (services/imessage-commands.ts) both resolve through this one function so the
// two surfaces cannot drift. The caller establishes owner authority; this core does no auth.

export type ResolveHealerProposalResult =
  | { ok: true; status: 'approved' | 'denied'; title: string }
  | { ok: false; code: 'not_found' | 'already_resolved' | 'bad_action'; error: string };

export function resolveHealerProposal(input: {
  id: string;
  action: string;
  note?: string | null;
}): ResolveHealerProposalResult {
  const { id } = input;
  const note = input.note ?? null;
  const db = getDb();
  const proposal = db.prepare('SELECT * FROM healer_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!proposal) return { ok: false, code: 'not_found', error: 'Proposal not found' };
  if (proposal.status !== 'pending') return { ok: false, code: 'already_resolved', error: `Proposal is already ${proposal.status}` };

  const title = String(proposal.title ?? 'a sensitive change');

  if (input.action === 'approve') {
    // A held destructive call files a proposal with a one-shot token and the signature of the exact
    // call. Mint the consumable approval now so the Healer's retry consumes it once. Model-authored
    // proposals carry no token and skip this.
    if (proposal.approval_token && proposal.approval_signature && proposal.agent_id) {
      try {
        grantApprovalForSignature({
          agentId: proposal.agent_id as string,
          signature: proposal.approval_signature as string,
          requestText: (proposal.proposed_fix as string | null) ?? (proposal.title as string),
          // The proposal carries the held call's full args, so the grant is exact-call.
          argsJson: (proposal.approval_args_json as string | null) ?? null,
        });
      } catch (err) {
        logger.error('Failed to mint bound destructive approval for held Healer proposal', {
          proposalId: id, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    db.prepare("UPDATE healer_proposals SET status = 'approved', resolved_at = datetime('now') WHERE id = ?").run(id);
    logger.info('Healer proposal approved', { proposalId: id, title: proposal.title });
    // Status-stamped broadcast so a pending decision toast drops even when the owner approved from
    // another surface (the Vitals card or an iMessage reply).
    try { broadcast({ type: 'healer:proposal', data: { id, status: 'approved' } }); } catch { /* best effort */ }

    // Approval only flips status; kick a healing cycle after ~30s (lets the status write settle)
    // so the fix applies soon instead of waiting for the next scheduled cycle.
    setTimeout(() => {
      runHealingCycle().catch((err) => {
        logger.warn('Post-approval healing cycle kick failed', {
          proposalId: id, error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 30_000);

    return { ok: true, status: 'approved', title };
  }

  // Verb mapping: the owner card says "decline", this route's verb is `deny`, and the stored
  // `healer_proposals.status` is 'denied'. All three mean the same thing.
  if (input.action === 'deny') {
    db.prepare("UPDATE healer_proposals SET status = 'denied', user_note = ?, resolved_at = datetime('now') WHERE id = ?").run(note ?? null, id);
    // Same status-stamped broadcast as the approve branch.
    try { broadcast({ type: 'healer:proposal', data: { id, status: 'denied' } }); } catch { /* best effort */ }

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

      // A Healer-denied discussion prompt is engine traffic: it goes on the events lane (conv_key NULL),
      // not into the primary's chat rows, and surfaces as a pending engine event.
      insertEngineEventIfAbsent({
        work: null,
        id: msgId,
        agentId: primaryId,
        content,
        sourceAgentId: null,
        originIntent: 'healer',
      });

      // The row is on the events lane, so its live broadcast rides interagent:message, never
      // chat:message (a chat frame would show a bubble that vanishes on reload).
      broadcast({
        type: 'interagent:message',
        agentId: primaryId,
        message: {
          id: msgId,
          agentId: primaryId,
          role: 'user',
          content,
          createdAt: new Date().toISOString(),
          sourceAgentId: null,
          senderName: 'Healer',
          recipientName: null,
          threadId: null,
          intent: 'healer',
          requiresResponse: false,
          originKind: 'engine',
        },
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
    return { ok: true, status: 'denied', title };
  }

  return { ok: false, code: 'bad_action', error: 'action must be "approve" or "deny"' };
}
