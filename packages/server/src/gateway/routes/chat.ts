import { Hono } from 'hono';
import { resolveOrCreateConversation } from '../../memory/conversations.js';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { SendMessageSchema } from '../../config/schema.js';
import { createLogger } from '../../logger.js';
import { getAgentRuntime } from '../../agent/runtime.js';
import { queueEmbedding } from '../../memory/embeddings.js';
import { insertInboundMessageIfAbsent } from '../../work/ask-title.js';
import { resetSession } from '../../agent/reset-session.js';
import { broadcast } from '../ws.js';
import type { Message } from '@dojo/shared';
import { deriveOrigin, legacyOriginInputs } from '@dojo/shared';

const logger = createLogger('chat-routes');

function buildContentWithAttachments(text: string, attachments: Array<{ fileId: string; filename: string; size: number; path: string; category: string }>): string {
  const parts: string[] = [text];

  for (const att of attachments) {
    if (att.category === 'text' || att.category === 'unknown') {
      // Point the agent at the file path; it reads the full contents with file_read (no size cap).
      parts.push(`\n[File attached: ${att.filename} (${att.size} bytes)]\nPath: ${att.path}\nUse file_read with this path to read the file contents.`);
    } else if (att.category === 'office') {
      parts.push(`\n[Office file attached: ${att.filename} (${att.size} bytes), fileId: ${att.fileId}]\nPath: ${att.path}\nConvert to PDF or text for better analysis.`);
    } else if (att.category === 'audio') {
      // No provider takes audio in chat completions, so surface the fileId for transcribe_audio.
      parts.push(`\n[Audio attached: ${att.filename} (${att.size} bytes), fileId: ${att.fileId}]\nPath: ${att.path}\nTo hear what the user said, call transcribe_audio with attachment_id="${att.fileId}". Do NOT pass `+'`path`'+` to transcribe_audio; that tool only accepts attachment_id or an https URL. The Path above is for forwarding the file (e.g. imessage_send).`);
    } else if (att.category === 'video') {
      // Same as audio: surface the fileId so the soundtrack can be transcribed; the path lets it forward the file.
      parts.push(`\n[Video attached: ${att.filename} (${att.size} bytes), fileId: ${att.fileId}]\nPath: ${att.path}\nTo transcribe the audio track, call transcribe_audio with attachment_id="${att.fileId}". To forward the file (e.g. imessage_send), use the Path above.`);
    } else if (att.category === 'image') {
      // Persisted into the row before the model is known (it may change), so this text must not assert what
      // the model can perceive; visibility is decided at assemble time. It carries only what is true on every model.
      parts.push(`\n[Image attached: ${att.filename} (${att.size} bytes), fileId: ${att.fileId}]\nPath: ${att.path}\nIf your model supports vision, this image is shown to you in this message; otherwise a text description or notice appears instead. Do not open image files with file_read. To send or forward the file (e.g. imessage_send), use the Path above. To use it as a reference image for video_create, pass attachment_id="${att.fileId}".`);
    } else if (att.category === 'pdf') {
      parts.push(`\n[PDF attached: ${att.filename} (${att.size} bytes), fileId: ${att.fileId}]\nPath: ${att.path}\nIf your model supports PDF input, the contents are shown to you in this message. To read the text yourself — or if no contents appear inline — call pdf_read with this Path (do NOT shell out to pdftotext/python). To forward the file (e.g. imessage_send), use the Path above. Other pdf_* tools (pdf_get_info, pdf_extract_pages, ...) also operate on the Path.`);
    }
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

/** Core path for posting a user message to an agent (chat HTTP route and voice session). */
type AttachmentCategory = 'unknown' | 'text' | 'image' | 'pdf' | 'office' | 'audio' | 'video';
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

  // Guard the attachment shape for every caller (voice bypasses the route's schema) before any DB write.
  if (attachments && attachments.length > 0) {
    const bad = attachments.some(
      (a) => !a
        || typeof a.path !== 'string' || a.path.length === 0
        || typeof a.filename !== 'string' || a.filename.length === 0
        || typeof a.fileId !== 'string' || a.fileId.length === 0
        || typeof a.size !== 'number' || !Number.isFinite(a.size),
    );
    if (bad) return { ok: false, error: 'Invalid attachment: missing file path or metadata', status: 400 };
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

  // Stamp structured origin on dashboard (non-voice) owner messages, so a pasted marker (`[A2A:...]`,
  // `[SOURCE: SCHEDULER]`) cannot make deriveOrigin reclassify the message and hide it. Voice has its own path.
  const dashMeta = source === 'voice'
    ? null
    : JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' });
  // The one channel this ingest is on, used for both the conversation identity and the row's `channel` stamp.
  const inboundChannel = source === 'voice' ? 'voice' : 'dashboard';
  const conversationId = resolveOrCreateConversation(agentId, {
    channel: inboundChannel, provider: null, counterpartyId: 'owner', threadRoot: null,
  });
  // Routing facts are stamped IN the insert, so the row is never briefly unstamped.
  insertInboundMessageIfAbsent({
    id: messageId,
    agentId,
    role: 'user',
    content: modelContent,
    attachments: attachments ? JSON.stringify(attachments) : null,
    channel: inboundChannel,
    senderId: 'owner',
    authorized: true,
    inboundMeta: dashMeta,
    conversationId,
  });

  logger.info('User message persisted', { agentId, messageId, attachmentCount: attachments?.length ?? 0 }, agentId);

  const createdAtRow = db
    .prepare(`SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages WHERE id = ?`)
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
      source: source ?? null,   // the ?source= query param of THIS request, not a column read
      // The same binding the insert used: the live feed builds its row from this frame, and the dashboard
      // reads the column to tell a person's question from an engine trigger.
      conversationId,
    },
  });

  queueEmbedding('message', messageId, agentId, content);

  // A dashboard message does not flip presence; the reply binding (`agent/v2/reply-destination.ts`) answers it.

  // Deliberately do NOT preempt the running turn: an abort lands after the turn committed side effects and
  // before it marks its work served, so the retry redid that work. handleMessage's activeRuns guard queues
  // this message as a pending wakeup and the end-of-turn drain serves it next. Stop is the explicit stopAgent.

  // A fresh user message clears any stale stop signal, or the loop would bail on it before processing.
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

chatRouter.post('/:agentId/messages', async (c) => {
  const agentId = c.req.param('agentId');
  const body = await c.req.json().catch(() => null);

  // Untrusted body (attachment pointers are persisted and handed to file_read): validate, 400 before any write.
  const parsed = SendMessageSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return c.json({ ok: false, error: `Invalid request: ${detail}` }, 400);
  }

  const result = await submitUserMessage(agentId, parsed.data.content, parsed.data.attachments);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, (result.status ?? 400) as 400 | 404);
  }
  return c.json({ ok: true, data: { messageId: result.messageId } });
});

chatRouter.get('/:agentId/messages', (c) => {
  const agentId = c.req.param('agentId');
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const before = c.req.query('before'); // cursor: message ID for pagination
  // `?wordy=1` is still sent by the dashboard and ignored here: it is a client render mode, not a served set.

  const db = getDb();

  const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId);
  if (!agent) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  let rows: Array<Record<string, unknown>>;

  // Filter out legacy stop marker rows (the marker is now injected only at context-assembly time).
  const STOP_MARKER_FILTER = "content NOT LIKE '[STOPPED BY USER]%'";

  // `retired_at` is display suppression only: it hides legacy pre-cutover inter-agent rows. `lane` is whose
  // traffic this is. They answer different questions, so both predicates stay.
  const RETIRED_FILTER = 'retired_at IS NULL';

  // The fail-closed human surface: `chat_messages` is exactly these two predicates. Wordy mode does not widen
  // it (a client render mode); inter-agent output is served by `GET /api/interagent/:agentId`.
  const OWNER_LANE_FILTER = "lane = 'owner'";

  // Serving contract: `messages` is the conversation; the client renders visible rows in regular mode and
  // everything in wordy mode. Do not filter the served set by display tier: it broke raw-row pagination.
  if (before) {
    // The cursor is the strictly-monotonic insertion key: a `created_at <` cursor could skip a same-second sibling.
    const cursorMsg = db.prepare('SELECT seq AS rowid FROM messages WHERE id = ?').get(before) as { rowid: number } | undefined;
    if (!cursorMsg) {
      return c.json({ ok: false, error: 'Invalid cursor message ID' }, 400);
    }

    rows = db.prepare(`
      SELECT *, datetime(created_at/1000,'unixepoch') AS created_at FROM messages
      WHERE agent_id = ? AND rowid < ? AND ${STOP_MARKER_FILTER} AND ${RETIRED_FILTER}
        AND ${OWNER_LANE_FILTER}
      ORDER BY rowid DESC
      LIMIT ?
    `).all(agentId, cursorMsg.rowid, Math.min(limit, 200)) as Array<Record<string, unknown>>;
  } else {
    rows = db.prepare(`
      SELECT *, datetime(created_at/1000,'unixepoch') AS created_at FROM messages
      WHERE agent_id = ? AND ${STOP_MARKER_FILTER} AND ${RETIRED_FILTER}
        AND ${OWNER_LANE_FILTER}
      ORDER BY rowid DESC
      LIMIT ?
    `).all(agentId, Math.min(limit, 200)) as Array<Record<string, unknown>>;
  }

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
    // Served so a reloaded browser renders the engine's turn-end re-classification of non-answer bubbles
    // (one column moves; `content` is untouched). Not a filter: the client decides what to draw.
    displayKind: (row.display_kind as Message['displayKind']) ?? null,
    attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
    source: row.lane === 'a2a' ? 'a2a' : row.channel === 'voice' ? 'voice' : null,
    // `conversations.id`: resolved at ingest on inbound rows, stamped on the agent's own assistant/tool rows at
    // turn end, null for a background or engine turn. The dashboard uses it to hide background-run tool chips.
    conversationId: (row.conversation_id as string | null | undefined) ?? null,
    // Canonical attribution for the dashboard's origin classifier; mirrors the memory store and agents.ts.
    origin: deriveOrigin({
      role: row.role as Message['role'],
      content: (row.content as string | null) ?? null,
      ...legacyOriginInputs(row.lane as string | null, row.channel as string | null),
      sourceAgentId: (row.source_agent_id as string | null) ?? null,
      a2aThreadId: (row.a2a_thread_id as string | null) ?? null,
      a2aIntent: (row.a2a_intent as string | null) ?? null,
      a2aRequiresResponse: (row.a2a_requires_response as number | null) ?? null,
      inboundMeta: (row.inbound_meta as string | null) ?? null,
      originIntent: (row.origin_intent as string | null) ?? null,
    }),
  };
}

chatRouter.post('/:agentId/new-session', async (c) => {
  const agentId = c.req.param('agentId');
  try {
    const result = await resetSession(agentId, { callerAgentId: null });
    if (!result.ok) return c.json({ ok: false, error: result.error }, result.code === 'not_found' ? 404 : 400);
    logger.info('New session started', { agentId, agentName: result.name, archiveId: result.archiveId });
    return c.json({ ok: true, data: { archiveId: result.archiveId, sessionStartedAt: result.boundary } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to start new session', { agentId, error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { chatRouter };
