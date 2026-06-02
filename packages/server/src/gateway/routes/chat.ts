import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import { getDb } from '../../db/connection.js';
import { SendMessageSchema } from '../../config/schema.js';
import { createLogger } from '../../logger.js';
import { getAgentRuntime } from '../../agent/runtime.js';
import { queueEmbedding } from '../../memory/embeddings.js';
import { archiveAgentConversation } from '../../vault/archive.js';
import { replaceContextItems } from '../../memory/dag.js';
import { broadcast } from '../ws.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('chat-routes');

function buildContentWithAttachments(text: string, attachments: Array<{ filename: string; size: number; path: string; category: string }>): string {
  const parts: string[] = [text];

  for (const att of attachments) {
    if (att.category === 'text' || att.category === 'unknown') {
      // Point the agent at the file path — let it use file_read to get the full contents.
      // Previously we injected content inline with a 50K char cap; this approach has no
      // size limit and keeps the message layer thin.
      parts.push(`\n[File attached: ${att.filename} (${att.size} bytes)]\nPath: ${att.path}\nUse file_read with this path to read the file contents.`);
    } else if (att.category === 'office') {
      parts.push(`\n[Office file attached: ${att.filename} (${att.size} bytes). Convert to PDF or text for better analysis.]`);
    }
    // Images and PDFs are handled at the model call layer via content blocks
  }

  return parts.join('\n');
}

const chatRouter = new Hono();

export interface SubmitUserMessageResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  status?: number;
}

/**
 * Core path for posting a user message to an agent. Used by the chat HTTP route
 * and by the voice session (transcript → message). Persists, broadcasts, preempts
 * any inflight model call, and triggers the runtime. Does not block on the agent's
 * response — chat:chunk events will fire as the response streams.
 */
type AttachmentCategory = 'unknown' | 'text' | 'image' | 'pdf' | 'office';
type ChatAttachment = { fileId: string; filename: string; mimeType: string; size: number; path: string; category: AttachmentCategory };

export async function submitUserMessage(
  agentId: string,
  content: string,
  attachments?: ChatAttachment[],
  source?: 'voice' | null,
): Promise<SubmitUserMessageResult> {
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, error: 'Message content is required', status: 400 };
  }

  const db = getDb();
  const agent = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(agentId) as { id: string; status: string } | undefined;

  if (!agent) return { ok: false, error: 'Agent not found', status: 404 };
  if (agent.status === 'terminated') return { ok: false, error: 'Agent is terminated', status: 400 };

  const messageId = uuidv4();
  let modelContent = content;
  if (attachments && attachments.length > 0) {
    modelContent = buildContentWithAttachments(content, attachments);
  }

  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, source, created_at)
    VALUES (?, ?, 'user', ?, ?, ?, datetime('now'))
  `).run(messageId, agentId, modelContent, attachments ? JSON.stringify(attachments) : null, source ?? null);

  logger.info('User message persisted', { agentId, messageId, attachmentCount: attachments?.length ?? 0 }, agentId);

  const createdAtRow = db
    .prepare('SELECT created_at FROM messages WHERE id = ?')
    .get(messageId) as { created_at: string } | undefined;
  broadcast({
    type: 'chat:message',
    agentId,
    message: {
      id: messageId,
      agentId,
      role: 'user',
      content: modelContent,
      attachments: attachments ?? undefined,
      tokenCount: null,
      modelId: null,
      cost: null,
      latencyMs: null,
      createdAt: createdAtRow?.created_at ?? new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
      source: source ?? null,
    },
  });

  queueEmbedding('message', messageId, agentId, content);

  try {
    const { preemptAgentForUrgentMessage } = await import('../../agent/runtime.js');
    preemptAgentForUrgentMessage(agentId);
  } catch { /* best effort */ }

  // A fresh user message means the user wants the agent to act. Any
  // stale stop signal from a prior interrupted turn must be cleared, or
  // the v2 loop will read the flag on the very first iteration, delete
  // it, and bail before processing the new message. (2026-06-02 bug
  // fix: user interrupted an agent mid-task, reset its session, sent a
  // new prompt — the agent's loop saw the stale stop flag and ended
  // without doing anything.)
  try {
    const { stoppedAgents } = await import('../../agent/shared-state.js');
    stoppedAgents.delete(agentId);
  } catch { /* best effort */ }

  const runtime = getAgentRuntime();
  runtime.handleMessage(agentId, modelContent).catch((err) => {
    logger.error('Agent runtime error', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  });

  return { ok: true, messageId };
}

// POST /:agentId/messages
chatRouter.post('/:agentId/messages', async (c) => {
  const agentId = c.req.param('agentId');
  const body = await c.req.json().catch(() => null);

  const content = (body?.content ?? '') as string;
  const attachments = Array.isArray(body?.attachments) ? body.attachments : undefined;

  const result = await submitUserMessage(agentId, content, attachments);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, (result.status ?? 400) as 400 | 404);
  }
  return c.json({ ok: true, data: { messageId: result.messageId } });
});

// GET /:agentId/messages
chatRouter.get('/:agentId/messages', (c) => {
  const agentId = c.req.param('agentId');
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const before = c.req.query('before'); // cursor: message ID for pagination

  const db = getDb();

  // Verify agent exists
  const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId);
  if (!agent) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  let rows: Array<Record<string, unknown>>;

  // Filter out legacy stop marker rows written by v1.10.4's earlier
  // stopAgent() implementation. The stop marker is now injected only at
  // context-assembly time and is never persisted, but older production
  // databases may still contain marker rows that should not appear in
  // the user-facing chat feed.
  const STOP_MARKER_FILTER = "content NOT LIKE '[STOPPED BY USER]%'";

  if (before) {
    // Get the timestamp of the cursor message
    const cursorMsg = db.prepare('SELECT created_at FROM messages WHERE id = ?').get(before) as { created_at: string } | undefined;
    if (!cursorMsg) {
      return c.json({ ok: false, error: 'Invalid cursor message ID' }, 400);
    }

    rows = db.prepare(`
      SELECT * FROM messages
      WHERE agent_id = ? AND created_at < ? AND ${STOP_MARKER_FILTER}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(agentId, cursorMsg.created_at, Math.min(limit, 200)) as Array<Record<string, unknown>>;
  } else {
    rows = db.prepare(`
      SELECT * FROM messages
      WHERE agent_id = ? AND ${STOP_MARKER_FILTER}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(agentId, Math.min(limit, 200)) as Array<Record<string, unknown>>;
  }

  // Reverse to chronological order
  rows.reverse();

  const messages: Message[] = rows.map(rowToMessage);
  return c.json({ ok: true, data: messages });
});

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    role: row.role as Message['role'],
    content: row.content as string,
    tokenCount: row.token_count as number | null,
    modelId: row.model_id as string | null,
    cost: row.cost as number | null,
    latencyMs: row.latency_ms as number | null,
    createdAt: row.created_at as string,
    reasoningContent: (row.reasoning_content as string | null) ?? null,
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
    source: (row.source as 'voice' | null | undefined) ?? null,
  };
}

// POST /chat/:agentId/new-session — start a fresh session
chatRouter.post('/:agentId/new-session', async (c) => {
  const agentId = c.req.param('agentId');
  const db = getDb();

  // Verify agent exists
  const agent = db.prepare('SELECT id, name, status FROM agents WHERE id = ?').get(agentId) as { id: string; name: string; status: string } | undefined;
  if (!agent) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  // Don't allow new session while agent is working
  if (agent.status === 'working') {
    return c.json({ ok: false, error: 'Cannot start new session while agent is working' }, 400);
  }

  try {
    // 1. Archive current conversation to vault (for Dreamer to process later)
    const archiveId = archiveAgentConversation(agentId);
    logger.info('Session archived for new session', { agentId, archiveId });

    // 2. Preserve context items (summaries) across session reset.
    // Summaries are compressed history of what the agent was working on.
    // Clearing them causes amnesia — the agent loses all project context.
    // The session_started_at boundary prevents old raw messages from
    // appearing, but summaries are the ONLY continuity across a reset.
    // (Previously this called replaceContextItems(agentId, []) which
    // wiped all summaries, causing post-reset amnesia.)

    // Clear session-loaded tool docs
    try {
      const { clearSessionLoadedTools } = await import('../../tools/tool-docs.js');
      clearSessionLoadedTools(agentId);
    } catch { /* ignore */ }

    // 3. Set session boundary — messages before this are excluded from context
    //    Use SQLite datetime format (not ISO) to match the messages table format
    const now = new Date();
    const boundary = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.prepare("UPDATE agents SET session_started_at = ?, updated_at = ?, config = json_remove(COALESCE(config, '{}'), '$.continuityBrief') WHERE id = ?").run(boundary, boundary, agentId);

    // 4. Insert session marker for the UI divider only
    const markerId = uuidv4();

    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, ?)
    `).run(markerId, agentId, '── New Session ──', boundary);

    // 5. Broadcast the divider so the chat UI updates in real time
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: markerId,
        agentId,
        role: 'system',
        content: '── New Session ──',
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: boundary,
      },
    });

    // 6. Inject the reorientation prompt. The helper picks between full
    // reorient (agent has active tasks → resume) and fresh-start (no
    // active tasks → clean slate, don't dredge up old work). Pre-2026-04-30
    // this always inserted the full reorient, which fought the user's
    // intent when they reset specifically to start over.
    const { buildSessionResetMessage } = await import('../../agent/session-reset.js');
    const reorientId = uuidv4();
    const reorientContent = buildSessionResetMessage(agentId);
    db.prepare("INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, ?)").run(reorientId, agentId, reorientContent, boundary);
    broadcast({ type: 'chat:message', agentId, message: { id: reorientId, agentId, role: 'system', content: reorientContent, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: boundary } });

    logger.info('New session started', { agentId, agentName: agent.name, archiveId });

    return c.json({ ok: true, data: { archiveId, sessionStartedAt: boundary } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to start new session', { agentId, error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { chatRouter };
