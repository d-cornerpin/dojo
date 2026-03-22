import { v4 as uuidv4 } from 'uuid';
import os from 'node:os';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { callModel } from '../agent/model.js';
import { broadcast } from '../gateway/ws.js';
import { estimateTokens } from './store.js';
import { getSummariesByAgent } from './dag.js';

const logger = createLogger('memory-briefing');

// Track scheduled intervals
const scheduledIntervals = new Map<string, ReturnType<typeof setInterval>>();

// ── Generate Briefing ──

export async function generateBriefing(
  agentId: string,
  modelId: string,
): Promise<{ id: string; content: string; tokenCount: number }> {
  const db = getDb();

  // Gather recent summaries (depth 1 and 2, last 48 hours)
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const recentSummaries = db.prepare(`
    SELECT id, depth, kind, content, earliest_at, latest_at, token_count
    FROM summaries
    WHERE agent_id = ?
      AND depth >= 1
      AND created_at >= ?
    ORDER BY earliest_at ASC
  `).all(agentId, cutoff) as Array<{
    id: string;
    depth: number;
    kind: string;
    content: string;
    earliest_at: string;
    latest_at: string;
    token_count: number;
  }>;

  // If no high-depth summaries, fall back to depth-0
  let summaryMaterial: string;
  if (recentSummaries.length === 0) {
    const leafSummaries = getSummariesByAgent(agentId, { depth: 0, limit: 20 });
    if (leafSummaries.length === 0) {
      // No summaries at all, create a minimal briefing
      const content = 'No conversation history available for briefing generation.';
      const id = await saveBriefing(agentId, content);
      return { id, content, tokenCount: estimateTokens(content) };
    }
    summaryMaterial = leafSummaries.map(s =>
      `<summary depth="${s.depth}" time="${s.earliestAt} - ${s.latestAt}">\n${s.content}\n</summary>`,
    ).join('\n\n');
  } else {
    summaryMaterial = recentSummaries.map(s =>
      `<summary depth="${s.depth}" time="${s.earliest_at} - ${s.latest_at}">\n${s.content}\n</summary>`,
    ).join('\n\n');
  }

  // Gather system state
  const agentCount = (db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number }).count;
  const providerCount = (db.prepare('SELECT COUNT(*) as count FROM providers WHERE is_validated = 1').get() as { count: number }).count;
  const recentErrors = db.prepare(`
    SELECT COUNT(*) as count FROM audit_log
    WHERE action_type = 'error'
      AND created_at >= datetime('now', '-24 hours')
  `).get() as { count: number };

  const uptimeSeconds = Math.floor(process.uptime());
  const memUsage = process.memoryUsage();

  const systemState = [
    `System State:`,
    `- Uptime: ${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
    `- Agents: ${agentCount}`,
    `- Validated Providers: ${providerCount}`,
    `- Errors (24h): ${recentErrors.count}`,
    `- Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
    `- Host: ${os.hostname()}`,
    `- Current Time: ${new Date().toISOString()}`,
  ].join('\n');

  // Build the briefing prompt
  const systemPrompt = `You are generating a morning briefing for an AI agent. Create a concise, structured briefing that covers:

1. **What's In Progress** — Active tasks, ongoing projects, pending decisions
2. **Recent Decisions** — Key decisions made in the last 48 hours
3. **System Health** — Platform status, any issues
4. **Notable Items** — Anything unusual or requiring attention

Write in a clear, professional tone. Be concise but thorough. Use bullet points.
Do NOT include preamble like "Here is your briefing" — start directly with the content.`;

  const userMessage = `Generate a morning briefing from the following material:\n\n${summaryMaterial}\n\n${systemState}`;

  try {
    const result = await callModel({
      agentId,
      modelId,
      messages: [{ role: 'user', content: userMessage }],
      systemPrompt,
      tools: false,
    });

    const id = await saveBriefing(agentId, result.content);
    const tokenCount = estimateTokens(result.content);

    broadcast({
      type: 'memory:briefing',
      agentId,
      briefingId: id,
      tokenCount,
    });

    logger.info('Briefing generated', {
      briefingId: id,
      tokenCount,
      summaryCount: recentSummaries.length,
    }, agentId);

    return { id, content: result.content, tokenCount };
  } catch (err) {
    logger.error('Briefing generation failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    throw err;
  }
}

// ── Get Latest Briefing ──

export function getLatestBriefing(agentId: string): { content: string; tokenCount: number } | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT content, token_count FROM briefings
    WHERE agent_id = ?
    ORDER BY generated_at DESC
    LIMIT 1
  `).get(agentId) as { content: string; token_count: number } | undefined;

  if (!row) return null;

  return {
    content: row.content,
    tokenCount: row.token_count,
  };
}

// ── Update Briefing ──

export function updateBriefing(agentId: string, content: string): void {
  const db = getDb();
  const tokenCount = estimateTokens(content);

  // Update the latest briefing with manual edits
  const existing = db.prepare(`
    SELECT id FROM briefings
    WHERE agent_id = ?
    ORDER BY generated_at DESC
    LIMIT 1
  `).get(agentId) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE briefings SET content = ?, token_count = ?, manual_edits = ?
      WHERE id = ?
    `).run(content, tokenCount, new Date().toISOString(), existing.id);

    logger.info('Briefing updated manually', {
      briefingId: existing.id,
      tokenCount,
    }, agentId);
  } else {
    // Create new if none exists
    saveBriefing(agentId, content);
  }
}

// ── Schedule Briefing ──

export function scheduleBriefing(
  agentId: string,
  modelId: string,
  cronExpression?: string,
): void {
  // Clear any existing schedule for this agent
  const existing = scheduledIntervals.get(agentId);
  if (existing) {
    clearInterval(existing);
    scheduledIntervals.delete(agentId);
  }

  // Default: every 24 hours
  // Simple approach using setInterval rather than full cron parsing
  const intervalMs = parseInterval(cronExpression);

  const interval = setInterval(async () => {
    try {
      await generateBriefing(agentId, modelId);
    } catch (err) {
      logger.error('Scheduled briefing generation failed', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }, intervalMs);

  // Don't keep the process alive just for briefing intervals
  interval.unref();

  scheduledIntervals.set(agentId, interval);

  logger.info('Briefing scheduled', {
    intervalMs,
    intervalHours: intervalMs / (60 * 60 * 1000),
    cronExpression: cronExpression ?? 'default (24h)',
  }, agentId);
}

// ── Helpers ──

async function saveBriefing(agentId: string, content: string): Promise<string> {
  const db = getDb();
  const id = `brief_${uuidv4()}`;
  const tokenCount = estimateTokens(content);

  db.prepare(`
    INSERT INTO briefings (id, agent_id, content, token_count, generated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(id, agentId, content, tokenCount);

  return id;
}

function parseInterval(cronExpression?: string): number {
  if (!cronExpression) {
    return 24 * 60 * 60 * 1000; // 24 hours default
  }

  // Simple parsing: support basic interval expressions
  const match = cronExpression.match(/^every\s+(\d+)\s*(h|hour|hours|m|min|minutes?)$/i);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('h')) {
      return value * 60 * 60 * 1000;
    }
    if (unit.startsWith('m')) {
      return value * 60 * 1000;
    }
  }

  // If we can't parse, default to 24 hours
  logger.warn('Could not parse cron expression, using 24h default', { cronExpression });
  return 24 * 60 * 60 * 1000;
}
