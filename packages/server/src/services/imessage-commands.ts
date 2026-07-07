// ════════════════════════════════════════
// Built-in iMessage Command Handlers
// ════════════════════════════════════════

import os from 'node:os';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { terminateAgent } from '../agent/spawner.js';
import { getPrimaryAgentId, getPrimaryAgentName } from '../config/platform.js';

const logger = createLogger('imessage-commands');

// ── Parsed command grammar ──────────────────────────────────────────────────
// Strict commands are unambiguous keywords. Approve/deny are ambiguous with
// ordinary chat ("ok", "no"), so they are parsed separately and only treated as
// a command when they actually resolve a pending imessage-surface proposal.
type StrictCommand =
  | { kind: 'status' }
  | { kind: 'kill-all' }
  | { kind: 'kill-named'; name: string }
  | { kind: 'pause' }
  | { kind: 'resume' };

type ApproveDenyCommand = { kind: 'approve' | 'deny'; shortId: string };

function parseStrictCommand(trimmed: string): StrictCommand | null {
  if (trimmed === 'status') return { kind: 'status' };
  if (trimmed === 'kill all') return { kind: 'kill-all' };
  const killMatch = trimmed.match(/^kill\s+(.+)$/);
  if (killMatch && killMatch[1] !== 'all') return { kind: 'kill-named', name: killMatch[1] };
  if (trimmed === 'pause') return { kind: 'pause' };
  if (trimmed === 'resume') return { kind: 'resume' };
  return null;
}

// B2: approve/deny of a proposal REQUIRES the hex short id (the outbound text
// instructs exactly that: Reply "yes 1a2b3c"). The id is the first 8 chars of a
// uuid, so it is hex-only, which means ordinary chatter can never parse as a
// command. A bare "yes"/"ok"/"no" (no id) is NEVER an approval: it returns null
// here and flows through as ordinary chat, so an unrelated "ok" cannot resolve a
// live destructive proposal that happens to be pending.
function parseApproveDeny(trimmed: string): ApproveDenyCommand | null {
  const yes = trimmed.match(/^(?:yes|approve|ok)\s+([0-9a-f]{4,})$/);
  if (yes) return { kind: 'approve', shortId: yes[1] };
  const no = trimmed.match(/^(?:no|deny|decline)\s+([0-9a-f]{4,})$/);
  if (no) return { kind: 'deny', shortId: no[1] };
  return null;
}

/**
 * Handle an inbound iMessage command from a bridged sender.
 *
 * OWNER GATE (D-B step 5, closes the pre-existing security gap): every command
 * here (status / kill / pause / resume AND the D-B approve/deny lane) mutates
 * platform state, so the sender MUST resolve to the is_primary safe-sender
 * (the owner) before ANY of them run. A non-owner's command text is NOT a
 * command: we return null so it flows on to the primary agent as an ordinary
 * message, never an error that would leak the command surface.
 *
 * @param text          raw inbound message text
 * @param senderAddress the sender's iMessage address (phone / Apple ID)
 */
export async function handleIMCommand(text: string, senderAddress: string): Promise<string | null> {
  const trimmed = text.trim().toLowerCase();

  // Resolve the sender to a safe-sender row and require the owner mapping.
  // (Dynamic import keeps the module graph tidy and avoids a bridge<->commands
  // static import cycle; these are live-binding function calls at runtime.)
  const { getSafeSenders, findSafeSenderByAddress } = await import('./imessage-bridge.js');
  const senderRecord = findSafeSenderByAddress(getSafeSenders(), senderAddress);
  const isOwner = !!senderRecord?.is_primary;

  // 1. Strict, unambiguous platform commands.
  const strict = parseStrictCommand(trimmed);
  if (strict) {
    if (!isOwner) {
      logger.warn('iMessage command refused: sender is not the owner', {
        command: strict.kind,
        knownSender: !!senderRecord,
      });
      return null; // flows on as an ordinary message; never leak the command surface
    }
    switch (strict.kind) {
      case 'status': return getStatusReport();
      case 'kill-all': return killAllAgents();
      case 'kill-named': return killNamedAgent(strict.name);
      case 'pause': return pausePrimaryAgent();
      case 'resume': return resumePrimaryAgent();
    }
  }

  // 2. D-B approve/deny lane (gated the same way). B2: only "yes <id>"/"no <id>"
  // reach here; a bare reply parsed as null above and never gets this far.
  const approveDeny = parseApproveDeny(trimmed);
  if (approveDeny) {
    if (!isOwner) {
      // An explicit approval attempt (it carried an id) by a non-owner: log it
      // and flow on as ordinary chat, never leak the approval surface.
      logger.warn('iMessage approval refused: sender is not the owner', {
        action: approveDeny.kind,
        knownSender: !!senderRecord,
      });
      return null;
    }
    return handleApproveDeny(approveDeny);
  }

  // Not a command, so return null to forward to the primary agent.
  return null;
}

/**
 * D-B step 5: resolve an approval from the iMessage lane. Runs the SAME shared
 * core as the dashboard route (resolveHealerProposal), so the two surfaces
 * cannot drift. Only pending imessage-surface proposals are reachable here.
 */
async function handleApproveDeny(cmd: ApproveDenyCommand): Promise<string | null> {
  const db = getDb();
  const pending = db.prepare(`
    SELECT id FROM healer_proposals
    WHERE status = 'pending' AND surface = 'imessage'
    ORDER BY created_at DESC
  `).all() as Array<{ id: string }>;

  // Nothing to act on: let "yes <id>" whose proposal already resolved flow on
  // to the agent as an ordinary reply rather than erroring.
  if (pending.length === 0) return null;

  // B2: the id is mandatory (parseApproveDeny guarantees it). We match the
  // supplied hex id against the pending set, so an owner must name the exact
  // proposal; there is no "newest pending" fallback that a bare reply could hit.
  const wanted = cmd.shortId.toLowerCase();
  const targetId = pending.find(p => p.id.toLowerCase().startsWith(wanted))?.id;
  if (!targetId) return 'I could not find a pending approval matching that.';

  const { resolveHealerProposal } = await import('../gateway/routes/healer.js');
  const result = resolveHealerProposal({ id: targetId, action: cmd.kind, note: null });
  if (!result.ok) {
    // Raced (resolved on another surface between our read and the write).
    return 'I could not find a pending approval matching that.';
  }
  return cmd.kind === 'approve'
    ? 'Approved. Your helper will make the change shortly and confirm.'
    : 'Got it, I will not make that change. Nothing was changed.';
}

function getStatusReport(): string {
  try {
    const db = getDb();

    const agentCount = (db.prepare(`
      SELECT COUNT(*) as count FROM agents WHERE status NOT IN ('terminated')
    `).get() as { count: number }).count;

    const workingCount = (db.prepare(`
      SELECT COUNT(*) as count FROM agents WHERE status = 'working'
    `).get() as { count: number }).count;

    const primaryStatus = (db.prepare(
      'SELECT status FROM agents WHERE id = ?'
    ).get(getPrimaryAgentId()) as { status: string } | undefined)?.status ?? 'unknown';

    const memInfo = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    const todayCost = (db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_records
      WHERE created_at >= datetime('now', '-1 day')
    `).get() as { total: number }).total;

    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);

    return [
      'DOJO Status Report',
      `${getPrimaryAgentName()}: ${primaryStatus}`,
      `Agents: ${agentCount} active (${workingCount} working)`,
      `Memory: ${Math.round(freeMem / 1024 / 1024)}MB free / ${Math.round(totalMem / 1024 / 1024)}MB total`,
      `Heap: ${Math.round(memInfo.heapUsed / 1024 / 1024)}MB`,
      `Today's cost: $${todayCost.toFixed(4)}`,
      `Uptime: ${hours}h ${mins}m`,
    ].join('\n');
  } catch (err) {
    logger.error('Failed to generate status report', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'Error generating status report.';
  }
}

function killAllAgents(): string {
  try {
    const db = getDb();
    const agents = db.prepare(`
      SELECT id, name FROM agents
      WHERE status NOT IN ('terminated') AND agent_type = 'standard'
    `).all() as Array<{ id: string; name: string }>;

    if (agents.length === 0) {
      return 'No active sub-agents to terminate.';
    }

    for (const agent of agents) {
      terminateAgent(agent.id, 'Killed via iMessage command');
    }

    return `Terminated ${agents.length} agent(s): ${agents.map(a => a.name).join(', ')}`;
  } catch (err) {
    logger.error('Failed to kill all agents', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'Error terminating agents.';
  }
}

function killNamedAgent(name: string): string {
  try {
    const db = getDb();
    const agent = db.prepare(`
      SELECT id, name FROM agents
      WHERE LOWER(name) = ? AND status NOT IN ('terminated')
    `).get(name.trim()) as { id: string; name: string } | undefined;

    if (!agent) {
      return `No active agent found with name "${name}".`;
    }

    terminateAgent(agent.id, 'Killed via iMessage command');
    return `Terminated agent "${agent.name}" (${agent.id}).`;
  } catch (err) {
    logger.error('Failed to kill named agent', {
      error: err instanceof Error ? err.message : String(err),
      name,
    });
    return `Error terminating agent "${name}".`;
  }
}

function pausePrimaryAgent(): string {
  try {
    const db = getDb();
    const primaryId = getPrimaryAgentId();
    db.prepare("UPDATE agents SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(primaryId);
    logger.info('Primary agent paused via iMessage', { primaryId });
    return 'Agent paused. Send "resume" to continue.';
  } catch (err) {
    logger.error('Failed to pause primary agent', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'Error pausing agent.';
  }
}

function resumePrimaryAgent(): string {
  try {
    const db = getDb();
    const primaryId = getPrimaryAgentId();
    db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(primaryId);
    logger.info('Primary agent resumed via iMessage', { primaryId });
    return 'Agent resumed.';
  } catch (err) {
    logger.error('Failed to resume primary agent', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'Error resuming agent.';
  }
}
