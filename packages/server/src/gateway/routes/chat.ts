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

function buildContentWithAttachments(text: string, attachments: Array<{ fileId: string; filename: string; mimeType: string; size: number; path: string; category: string }>): string {
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

// POST /:agentId/messages
chatRouter.post('/:agentId/messages', async (c) => {
  const agentId = c.req.param('agentId');
  const body = await c.req.json().catch(() => null);

  if (!body?.content || typeof body.content !== 'string' || body.content.trim().length === 0) {
    return c.json({ ok: false, error: 'Message content is required' }, 400);
  }

  const db = getDb();
  const agent = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(agentId) as { id: string; status: string } | undefined;

  if (!agent) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  if (agent.status === 'terminated') {
    return c.json({ ok: false, error: 'Agent is terminated' }, 400);
  }

  const content = body.content as string;
  const attachments = Array.isArray(body.attachments) ? body.attachments : null;
  const messageId = uuidv4();
  const isBusy = agent.status === 'working';

  // Build content for the model — includes attachment data
  let modelContent = content;
  if (attachments && attachments.length > 0) {
    modelContent = buildContentWithAttachments(content, attachments);
  }

  // Always persist user message immediately
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, created_at)
    VALUES (?, ?, 'user', ?, ?, datetime('now'))
  `).run(messageId, agentId, modelContent, attachments ? JSON.stringify(attachments) : null);

  logger.info('User message persisted', { agentId, messageId, queued: isBusy, attachmentCount: attachments?.length ?? 0 }, agentId);

  queueEmbedding('message', messageId, agentId, content);

  if (!isBusy) {
    const runtime = getAgentRuntime();
    runtime.handleMessage(agentId, modelContent).catch((err) => {
      logger.error('Agent runtime error', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    });
  }

  return c.json({ ok: true, data: { messageId, queued: isBusy } });
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
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
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

    // 2. Clear context items (summaries) — shed the accumulated conversation weight
    replaceContextItems(agentId, []);

    // Clear session-loaded tool docs
    try {
      const { clearSessionLoadedTools } = await import('../../tools/tool-docs.js');
      clearSessionLoadedTools(agentId);
    } catch { /* ignore */ }

    // 3. Set session boundary — messages before this are excluded from context
    //    Use SQLite datetime format (not ISO) to match the messages table format
    const now = new Date();
    const boundary = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.prepare('UPDATE agents SET session_started_at = ?, updated_at = ? WHERE id = ?').run(boundary, boundary, agentId);

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

    logger.info('New session started', { agentId, agentName: agent.name, archiveId });

    return c.json({ ok: true, data: { archiveId, sessionStartedAt: boundary } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to start new session', { agentId, error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { chatRouter };
