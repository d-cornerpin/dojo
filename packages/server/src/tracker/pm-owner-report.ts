// ════════════════════════════════════════════════════════════════════════════════════════
// SPINNING (t143, v3.3.3): THE PROJECT MANAGER TELLS THE OWNER, IN ITS OWN VOICE, WHAT REPEATS.
//
// The effort governor (`tracker/effort-governor.ts`) meters tool calls a task burns without
// advancing; past its threshold the PM rules ADVANCING or CIRCLING (`runEffortReview` in
// `pm-agent.ts`). A circling verdict already reaches the AGENT — the guarded poke sweep and the
// checkpoint rider deliver it, and the PM keeps re-driving. What never happened is the owner
// hearing about it. OR-V333-SET (3) keeps the platform's own direct line to the owner for budget
// and broken/silent only, so this is the PM speaking, not the platform: one message on the PM's
// own chat, naming the task, the agent, the step it keeps repeating (counted from the agent's own
// tool calls, not guessed) and the PM's reason. Nothing is asked of the owner (OR-PM-1).
//
// ONCE PER CIRCLING EPISODE: a second circling verdict on a task that has not moved since the
// first says nothing new. The episode is read off the task's own record — the `effort_review_
// intervene` entries since its last transition — so a restart cannot repeat it and a task that
// genuinely advanced and then circles again is a new episode.
// ════════════════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { getPMAgentId } from '../config/platform.js';
import { createLogger } from '../logger.js';

const logger = createLogger('pm-owner-report');

/** How many of the assignee's recent model turns to read for the repeated step. Reading, not a
 *  cap on anything the agent may do: it bounds one query, and the effort governor's own review
 *  threshold is what decided this task is circling. */
const RECENT_ASSISTANT_ROWS = 50;

/** The tool the agent has called most often in its recent turns, with the count. */
function repeatedStep(agentId: string): { tool: string; times: number } | null {
  const rows = getDb().prepare(`SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant'
      ORDER BY created_at DESC, seq DESC LIMIT ?`).all(agentId, RECENT_ASSISTANT_ROWS) as Array<{ content: string }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    let blocks: unknown;
    try { blocks = JSON.parse(r.content); } catch { continue; }
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Array<{ type?: unknown; name?: unknown }>) {
      if (b?.type === 'tool_use' && typeof b.name === 'string') counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? { tool: top[0], times: top[1] } : null;
}

/** Called right after the PM records a CIRCLING verdict. Best-effort: never throws into the review. */
export function reportCirclingToOwner(taskId: string, title: string, agentId: string | null, reason: string): void {
  try {
    const db = getDb();
    const episode = db.prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit'
        AND json_extract(payload, '$.entry_kind') = 'effort_review_intervene'
        AND id > COALESCE((SELECT MAX(id) FROM work_events WHERE work_id = ? AND kind = 'transition'), 0)`)
      .get(taskId, taskId) as { n: number };
    if (episode.n !== 1) return; // this episode was already reported (or the verdict was not recorded)

    const pmId = getPMAgentId();
    const name = agentId
      ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId
      : 'its agent';
    const step = agentId ? repeatedStep(agentId) : null;
    const content = `${name} seems to be going in circles on "${title}".`
      + (step ? ` The step it keeps repeating: ${step.tool} (${step.times} times in its recent work).` : '')
      + ` My read: ${reason.trim()}`
      + ` I've told ${name} to change approach and I'll keep it moving; nothing for you to do unless you want to step in.`;

    const id = uuidv4();
    const row = insertMessageIfAbsent({ id, agentId: pmId, role: 'assistant', content, subjectKind: 'background', taskId });
    if (!row) return;
    broadcast({
      type: 'chat:message', agentId: pmId,
      message: {
        id, agentId: pmId, role: 'assistant' as const, content,
        tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString(),
      },
    });
    broadcast({ type: 'chat:chunk', agentId: pmId, messageId: id, content: '', done: true, modelId: null });
    logger.info('PM told the owner a task is circling (once per episode)', { taskId, agentId });
  } catch (err) {
    logger.warn('PM circling report could not be written (the verdict still reaches the agent)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
