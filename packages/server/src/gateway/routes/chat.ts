import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db/connection.js';
import { SendMessageSchema } from '../../config/schema.js';
import { createLogger } from '../../logger.js';
import { getAgentRuntime } from '../../agent/runtime.js';
import { queueEmbedding } from '../../memory/embeddings.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('chat-routes');

const MAX_TEXT_FILE_CHARS = 50000;

function buildContentWithAttachments(text: string, attachments: Array<{ fileId: string; filename: string; mimeType: string; size: number; path: string; category: string }>): string {
  const parts: string[] = [text];

  for (const att of attachments) {
    if (att.category === 'text' || att.category === 'unknown') {
      // Read text files and inject inline
      try {
        let fileContent = fs.readFileSync(att.path, 'utf-8');
        if (fileContent.length > MAX_TEXT_FILE_CHARS) {
          fileContent = fileContent.slice(0, MAX_TEXT_FILE_CHARS) + `\n... [TRUNCATED: file is ${att.size} bytes, showing first ${MAX_TEXT_FILE_CHARS} characters]`;
        }
        parts.push(`\n=== File: ${att.filename} ===\n${fileContent}\n=== End File ===`);
      } catch {
        parts.push(`\n[Could not read file: ${att.filename}]`);
      }
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
    INSERT INTO messages (id, agent_id, role, content, attachments, created_at)
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

  if (before) {
    // Get the timestamp of the cursor message
    const cursorMsg = db.prepare('SELECT created_at FROM messages WHERE id = ?').get(before) as { created_at: string } | undefined;
    if (!cursorMsg) {
      return c.json({ ok: false, error: 'Invalid cursor message ID' }, 400);
    }

    rows = db.prepare(`
      SELECT * FROM messages
      WHERE agent_id = ? AND created_at < ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(agentId, cursorMsg.created_at, Math.min(limit, 200)) as Array<Record<string, unknown>>;
  } else {
    rows = db.prepare(`
      SELECT * FROM messages
      WHERE agent_id = ?
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

export { chatRouter };
