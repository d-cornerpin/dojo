// ════════════════════════════════════════════════════════════════════════════════════════
// SPINNING (t143, v3.3.3): THE PROJECT MANAGER TELLS THE OWNER, IN ITS OWN VOICE, WHAT REPEATS.
//
// The effort governor (`tracker/effort-governor.ts`) meters tool calls a task burns without
// advancing; past its threshold the PM rules ADVANCING or CIRCLING (`runEffortReview` in
// `pm-agent.ts`). A circling verdict already reaches the AGENT — the guarded poke sweep and the
// checkpoint rider deliver it, and the PM keeps re-driving. What never happened is the owner
// hearing about it. OR-V333-SET (3) keeps the platform's own direct line to the owner for budget
// and broken/silent only, so this is the PM speaking, not the platform: one message on the PM's
// own chat, naming the task, the agent, the step it keeps repeating (the same call with the same
// arguments, counted from the agent's own calls since the task last moved, never its busiest tool) and the PM's reason. Nothing is asked of the owner (OR-PM-1).
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

/** How many of the assignee's model turns since the task last moved to read for the repeat.
 *  Reading, not a cap on anything the agent may do: it bounds one query. */
const RECENT_ASSISTANT_ROWS = 400;
/** A call counts as a REPEAT only from this many identical calls. Two is a retry, not a circle. */
const MIN_REPEATS = 3;

/** The call the agent repeats — the SAME tool with the SAME arguments — in its work since this
 *  task last moved (t143 round 3, I4). Not the busiest tool: an agent that ran twenty different
 *  shell commands is working, not circling, and the owner is not told "bash, 20 times". The
 *  effort governor keeps only a count (no signature of the repeat), so the repeat is read from
 *  the assignee's own calls, bounded to the task's current episode (since its last transition). */
function repeatedStep(agentId: string, taskId: string): { tool: string; times: number } | null {
  const db = getDb();
  const since = (db.prepare(`SELECT COALESCE(MAX(e.created_at), (SELECT w.opened_at FROM work w WHERE w.id = ?), 0) AS at
      FROM work_events e WHERE e.work_id = ? AND e.kind = 'transition'`).get(taskId, taskId) as { at: number }).at;
  const rows = db.prepare(`SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' AND created_at >= ?
      ORDER BY created_at DESC, seq DESC LIMIT ?`).all(agentId, since, RECENT_ASSISTANT_ROWS) as Array<{ content: string }>;
  const counts = new Map<string, { tool: string; times: number }>();
  for (const r of rows) {
    let blocks: unknown;
    try { blocks = JSON.parse(r.content); } catch { continue; }
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
      const sig = `${b.name}\u0000${JSON.stringify(b.input ?? null)}`;
      const seen = counts.get(sig) ?? { tool: b.name, times: 0 };
      seen.times += 1;
      counts.set(sig, seen);
    }
  }
  const top = [...counts.values()].sort((a, b) => b.times - a.times)[0];
  return top && top.times >= MIN_REPEATS ? top : null;
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
    const step = agentId ? repeatedStep(agentId, taskId) : null;
    const content = `${name} seems to be going in circles on "${title}".`
      + (step ? ` The step it keeps repeating: the same ${step.tool} call (${step.times} times since this task last moved).` : '')
      + ` My read: ${reason.trim()}`
      + ` I'm sending ${name} word to change approach and I'll keep it moving; nothing for you to do unless you want to step in.`;

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
