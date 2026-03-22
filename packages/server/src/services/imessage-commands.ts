// ════════════════════════════════════════
// Built-in iMessage Command Handlers
// ════════════════════════════════════════

import os from 'node:os';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { terminateAgent } from '../agent/spawner.js';
import { getPrimaryAgentId, getPrimaryAgentName } from '../config/platform.js';

const logger = createLogger('imessage-commands');

export async function handleIMCommand(text: string, recipientId: string): Promise<string | null> {
  const trimmed = text.trim().toLowerCase();

  // "status" — system health report
  if (trimmed === 'status') {
    return getStatusReport();
  }

  // "kill all" — terminate all sub-agents
  if (trimmed === 'kill all') {
    return killAllAgents();
  }

  // "kill {name}" — terminate specific agent
  const killMatch = trimmed.match(/^kill\s+(.+)$/);
  if (killMatch && killMatch[1] !== 'all') {
    return killNamedAgent(killMatch[1]);
  }

  // "pause" — pause primary agent
  if (trimmed === 'pause') {
    return pausePrimaryAgent();
  }

  // "resume" — resume primary agent
  if (trimmed === 'resume') {
    return resumePrimaryAgent();
  }

  // Not a command — return null to forward to primary agent
  return null;
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
