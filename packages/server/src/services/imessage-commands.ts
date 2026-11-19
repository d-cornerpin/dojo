// Built-in iMessage command handlers.

import os from 'node:os';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { terminateAgent } from '../agent/spawner.js';
import { writeAgentStatus } from '../agent/agent-status.js';
import { getPrimaryAgentId, getPrimaryAgentName } from '../config/platform.js';
import { dojoVoice } from '../agent/dojo-voice.js';

const logger = createLogger('imessage-commands');

import { parseStrictCommand, parseApproveDeny, firstLineOf, type ApproveDenyCommand } from './owner-command-words.js';

/**
 * Handle an inbound iMessage command from a bridged sender. Every command (status, kill, pause, resume and the
 * approve/deny lane) mutates platform state, so the sender MUST resolve to the is_primary safe-sender (the
 * owner) first. A non-owner's command text is not a command: null, so it flows to the primary agent as an
 * ordinary message and never leaks the command surface.
 *
 * @param text          raw inbound message text
 * @param senderAddress the sender's iMessage address (phone / Apple ID)
 */
export async function handleIMCommand(text: string, senderAddress: string): Promise<string | null> {
  const reply = await routeIMCommand(text, senderAddress);
  if (reply === null) return null;
  return dojoVoice(reply);   // the Dojo speaking; the bridge tells the agent once the send is done
}

async function routeIMCommand(text: string, senderAddress: string): Promise<string | null> {
  const trimmed = text.trim().toLowerCase();

  // Resolve the sender to the owner safe-sender row. Dynamic import avoids a bridge<->commands static cycle.
  const { getSafeSenders, findSafeSenderByAddress } = await import('./imessage-bridge.js');
  const senderRecord = findSafeSenderByAddress(getSafeSenders(), senderAddress);
  const isOwner = !!senderRecord?.is_primary;
  return runCommand(trimmed, isOwner, senderRecord);
}

/**
 * A CONFIRMED owner email is the owner speaking (`mail-owner-intake.ts` was the gate), so this runs the SAME
 * command and approval handler a text reaches. Null when the words are not a command.
 */
export async function handleConfirmedOwnerEmailWords(words: string): Promise<string | null> {
  return runCommand(firstLineOf(words), true, undefined);
}

async function runCommand(trimmed: string, isOwner: boolean, senderRecord: unknown): Promise<string | null> {
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

  // 2. Approve/deny lane (gated the same way): only "yes <id>"/"no <id>" reach here; a bare reply parsed as null above.
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
 * Resolves an approval from the iMessage lane through the SAME core as the dashboard route
 * (resolveHealerProposal), so the two surfaces cannot drift. Only pending imessage-surface proposals are reachable.
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

  // The id is mandatory (parseApproveDeny guarantees it): the owner must name the exact pending proposal,
  // with no "newest pending" fallback a bare reply could hit.
  const wanted = cmd.shortId.toLowerCase();
  const targetId = pending.find(p => p.id.toLowerCase().startsWith(wanted))?.id;
  if (!targetId) return 'No pending approval matches that.';

  const { resolveHealerProposal } = await import('../gateway/routes/healer.js');
  const result = resolveHealerProposal({ id: targetId, action: cmd.kind, note: null });
  if (!result.ok) {
    // Raced (resolved on another surface between our read and the write).
    return 'No pending approval matches that.';
  }
  return cmd.kind === 'approve'
    ? 'Approved. The helper will make the change shortly and confirm.'
    : 'Denied. Nothing was changed.';
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
      'Status report',
      `${getPrimaryAgentName()}: ${primaryStatus}`,
      `Agents: ${agentCount} active (${workingCount} working)`,
      `Memory: ${Math.round(freeMem / 1024 / 1024)}MB free / ${Math.round(totalMem / 1024 / 1024)}MB total`,
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
      WHERE status NOT IN ('terminated') AND agent_type = 'standard' AND classification != 'sensei'
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
    const primaryId = getPrimaryAgentId();
    // Through the one status writer, which also drops a park's tag: the owner's pause wins over a park.
    writeAgentStatus(primaryId, 'paused');
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
    const current = db.prepare('SELECT status FROM agents WHERE id = ?').get(primaryId) as { status: string } | undefined;
    if (current && (current.status === 'paused' || current.status === 'error')) {
      // Through the one status writer, which clears a park's tag and closes the "agent has stopped" owner card.
      writeAgentStatus(primaryId, 'idle', { clearError: true });
      logger.info('Primary agent resumed via iMessage', { primaryId });
      return 'Agent resumed.';
    }
    return 'Agent is not paused.';
  } catch (err) {
    logger.error('Failed to resume primary agent', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'Error resuming agent.';
  }
}
