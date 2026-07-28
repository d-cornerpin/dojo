import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../ws.js';
import { getHealerConfig, setHealerConfig, scheduleHealingCycle, runHealingCycle, sendHealerReport, getHealerLogContent } from '../../healer/healer-agent.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import { getAgentRuntime } from '../../agent/runtime.js';
import { insertEngineEventIfAbsent } from '../../memory/message-store.js';
import { grantApprovalForSignature } from '../../agent/destructive-gate.js';

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

// GET /proposals — list pending proposals + recently-resolved (last 48h).
// Pending entries always show (the user might need to act on them). Resolved
// (approved/denied) entries fall off after 48 hours so the vitals view stays
// uncluttered. Older history is still in the DB if you query it directly.
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

// POST /proposals/:id — approve or deny a proposal
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

// GET /actions — list auto-fix actions from the last 48 hours.
// Auto-fixes are inherently resolved (no user action needed), so anything
// older than 48 hours falls off the vitals view. Older history stays in the
// DB if you need to query it directly.
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
      const status = (result.error === 'NO_EMAIL_CONFIGURED' || result.error === 'NO_REPORT_RECIPIENT') ? 400 : 500;
      return c.json({ ok: false, error: result.error }, status);
    }
    return c.json({ ok: true, data: { message: 'Report sent and archived' } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ════════════════════════════════════════
// Shared proposal-resolution core (D-B step 5)
//
// The dashboard route (POST /proposals/:id) AND the iMessage approve/deny lane
// (services/imessage-commands.ts) both resolve a proposal through THIS single
// function, so the two surfaces can never drift: approve mints the bound
// destructive approval + kicks the cycle + status-broadcasts; deny resolves +
// notifies the primary for discussion. Owner authority is established by the
// caller (dashboard = single-user JWT; iMessage = the is_primary owner gate in
// handleIMCommand), so this core does no auth of its own.
// ════════════════════════════════════════

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
    // D-B step 2: an engine-HELD destructive call files a proposal that carries a
    // bound one-shot token + the canonical signature of the exact call the gate
    // paused. Mint the consumable destructive_approvals row now so the Healer's
    // re-attempt of that same call consumes it once and executes. Model-authored
    // proposals carry no token and skip this entirely.
    if (proposal.approval_token && proposal.approval_signature && proposal.agent_id) {
      try {
        grantApprovalForSignature({
          agentId: proposal.agent_id as string,
          signature: proposal.approval_signature as string,
          requestText: (proposal.proposed_fix as string | null) ?? (proposal.title as string),
          decidedBy: 'owner',
          // P7b: the proposal carries the held call's FULL args, so the minted
          // grant is exact-call like every other approval.
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
    // D-B step 4 seam: status-stamped broadcast so a pending decision toast for
    // this proposal drops even when the owner approved from a DIFFERENT surface
    // (the Vitals card or an iMessage reply). The toast's own button also
    // dismisses locally; this makes the surfaces converge.
    try { broadcast({ type: 'healer:proposal', data: { id, status: 'approved' } }); } catch { /* best effort */ }

    // FA-X7(b): approval only flips status; without a kick the approved fix
    // waits up to ~24h for the next scheduled cycle to apply it (and re-wakes
    // the Healer every cycle until then). Kick a prompt cycle so it applies
    // soon. runHealingCycle already wakes the Healer when an approved-but-
    // unapplied proposal exists, so this is a one-shot ~30s delay (lets the
    // status write settle without blocking this response), no new machinery
    // and no change to the Healer's normal cadence.
    setTimeout(() => {
      runHealingCycle().catch((err) => {
        logger.warn('Post-approval healing cycle kick failed', {
          proposalId: id, error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 30_000);

    return { ok: true, status: 'approved', title };
  }

  if (input.action === 'deny') {
    db.prepare("UPDATE healer_proposals SET status = 'denied', user_note = ?, resolved_at = datetime('now') WHERE id = ?").run(note ?? null, id);
    // D-B step 4 seam: same status-stamped broadcast as the approve branch.
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

      // D-A step 4: a Healer-denied discussion prompt is engine traffic
      // (lane='events'), so it lands on the EVENTS lane, structurally outside
      // the primary's `messages` chat table. The merged tail + assembler surface it
      // as a pending engine event (conv_key NULL) exactly as the old row did.
      insertEngineEventIfAbsent({
        work: null,
        id: msgId,
        agentId: primaryId,
        content,
        sourceAgentId: null,
        originIntent: 'healer',
        convKey: null,
      });

      // D-A step 5 seam: this row persists to the inter-agent STORE (above), so
      // its live broadcast rides the interagent:message lane like every other
      // engine-origin notice, never chat:message (a chat frame would show a
      // bubble that does not exist in `messages` and vanishes on reload).
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
