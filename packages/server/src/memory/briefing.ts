import { v4 as uuidv4 } from 'uuid';
import os from 'node:os';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { callModel } from '../agent/model.js';
import { broadcast } from '../gateway/ws.js';
import { estimateTokens } from './budget.js';
import { getSummariesByAgent } from './dag.js';
import { buildAgedWorkBriefSection } from '../work/obligations.js';

const logger = createLogger('memory-briefing');

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

    // PHASE-2 T7 (4b): aged obligations are never silently dropped. Anything still owed past
    // the ageing threshold gets a deterministic one-line-per-item section appended AFTER the
    // model pass, so a weak model cannot drop it ("still open, no answer: X, ask again or
    // drop?"). Only an explicit resolution or dismissal closes one.
    //
    // THIS IS NOW A PURE READ. The mechanism it replaces (`markStaleLoops`) fired an UPDATE
    // from inside this generator, flipping rows to `status='stale'` and then listing what it
    // had just written — a report that decided its own data. Ageing is a comparison against
    // `work.opened_at` now; the brief changes nothing.
    const agedSection = buildAgedWorkBriefSection(agentId);
    const content = agedSection ? `${result.content}\n\n${agedSection}` : result.content;

    const id = await saveBriefing(agentId, content);
    const tokenCount = estimateTokens(content);

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
      agedWork: agedSection ? true : false,
    }, agentId);

    return { id, content, tokenCount };
  } catch (err) {
    logger.error('Briefing generation failed', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    throw err;
  }
}

// ── Get Latest Briefing ──

/**
 * T67b — `generatedAt` IS RETURNED, AND THAT IS THE LOAD-BEARING PART.
 *
 * `lane.briefing` stamped its block `generated="${new Date()...}"` — THE ASSEMBLY CLOCK —
 * from inside the cacheable message region. The owner's local-DS4 trace found the prefix
 * diverging at token ~33,600 ON A DATE, with ~14,200 tokens re-prefilled every turn. A
 * briefing has exactly one generation date and the row has always recorded it; the lane was
 * simply reading the wrong clock. Returning the column is what lets the block state the
 * truth AND hold still between two assemblies of the same row.
 *
 * Format is the column's own (`datetime('now')` -> `YYYY-MM-DD HH:MM:SS`, or an ISO string
 * from `updateBriefing`'s manual path); the lane takes the leading date and nothing else.
 */
export function getLatestBriefing(
  agentId: string,
): { content: string; tokenCount: number; generatedAt: string | null } | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT content, token_count, generated_at FROM briefings
    WHERE agent_id = ?
    ORDER BY generated_at DESC
    LIMIT 1
  `).get(agentId) as { content: string; token_count: number; generated_at: string | null } | undefined;

  if (!row) return null;

  return {
    content: row.content,
    tokenCount: row.token_count,
    generatedAt: row.generated_at,
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
