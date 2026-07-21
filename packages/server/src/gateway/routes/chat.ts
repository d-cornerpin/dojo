import { Hono } from 'hono';
import { resolveOrCreateConversation } from '../../memory/conversations.js';
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
import { deriveOrigin } from '@dojo/shared';

const logger = createLogger('chat-routes');

function buildContentWithAttachments(text: string, attachments: Array<{ fileId: string; filename: string; size: number; path: string; category: string }>): string {
  const parts: string[] = [text];

  for (const att of attachments) {
    if (att.category === 'text' || att.category === 'unknown') {
      // Point the agent at the file path — let it use file_read to get the full contents.
      // Previously we injected content inline with a 50K char cap; this approach has no
      // size limit and keeps the message layer thin.
      parts.push(`\n[File attached: ${att.filename} (${att.size} bytes)]\nPath: ${att.path}\nUse file_read with this path to read the file contents.`);
    } else if (att.category === 'office') {
      parts.push(`\n[Office file attached: ${att.filename} (${att.size} bytes), fileId: ${att.fileId}]\nPath: ${att.path}\nConvert to PDF or text for better analysis.`);
    } else if (att.category === 'audio') {
      // Audio attachments aren't injectable as content blocks (no
      // provider accepts audio in chat completions yet for the
      // primary agent loop). Surface the fileId so the agent can
      // route it through transcribe_audio.
      parts.push(`\n[Audio attached: ${att.filename} (${att.size} bytes), fileId: ${att.fileId}]\nPath: ${att.path}\nTo hear what the user said, call transcribe_audio with attachment_id="${att.fileId}". Do NOT pass `+'`path`'+` to transcribe_audio; that tool only accepts attachment_id or an https URL. The Path above is for forwarding the file (e.g. imessage_send).`);
    } else if (att.category === 'video') {
      // Same as audio — surface the fileId so the agent can
      // transcribe the soundtrack if a video_create-style tool ever
      // wants to interrogate it. The path lets it forward the file.
      parts.push(`\n[Video attached: ${att.filename} (${att.size} bytes), fileId: ${att.fileId}]\nPath: ${att.path}\nTo transcribe the audio track, call transcribe_audio with attachment_id="${att.fileId}". To forward the file (e.g. imessage_send), use the Path above.`);
    } else if (att.category === 'image') {
      // This text is PERSISTED into the message row, where the model is not
      // yet known (and may change before the row is next read), so it must
      // not assert what the model can perceive. Visibility is owned at
      // assemble time: vision models get the image block, fallback-captioned
      // models get a description, capability banners cover the rest. This
      // pointer only carries what is true on every model: what the file is,
      // where it lives, and how to act on it.
      parts.push(`\n[Image attached: ${att.filename} (${att.size} bytes), fileId: ${att.fileId}]\nPath: ${att.path}\nIf your model supports vision, this image is shown to you in this message; otherwise a text description or notice appears instead. Do not open image files with file_read. To send or forward the file (e.g. imessage_send), use the Path above. To use it as a reference image for video_create, pass attachment_id="${att.fileId}".`);
    } else if (att.category === 'pdf') {
      // Same persistence constraint as images: no perception claims here.
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

/**
 * Core path for posting a user message to an agent. Used by the chat HTTP route
 * and by the voice session (transcript → message). Persists, broadcasts, preempts
 * any inflight model call, and triggers the runtime. Does not block on the agent's
 * response — chat:chunk events will fire as the response streams.
 */
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

  // FA-G1: guard the attachment shape for EVERY caller (the voice session calls
  // this directly, bypassing the route's schema). A malformed attachment would
  // otherwise persist a broken "[File attached: undefined ...] Path: undefined"
  // pointer that the model then file_reads. Reject before any DB write.
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

  // I-2 (comms-audit): stamp STRUCTURED origin on dashboard (non-voice) owner
  // messages. Before, dashboard messages had no inbound_meta, so deriveOrigin fell
  // back to prose parsing — a user who PASTED a transcript/log starting with a
  // recognized marker (`[A2A:...]`, `[SOURCE: SCHEDULER]`) had their own message
  // reclassified as an agent/engine event and HIDDEN from the chat. With structured
  // meta + the prose-subordination in deriveOrigin, a pasted marker can't hijack the
  // classification. Voice keeps its own source-based path.
  const dashMeta = source === 'voice'
    ? null
    : JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' });
  // P5: the owner's dashboard (and voice) is one conversation per agent.
  const conversationId = resolveOrCreateConversation(agentId, {
    channel: source === 'voice' ? 'voice' : 'dashboard', provider: null, counterpartyId: 'owner', threadRoot: null,
  });
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, source, inbound_meta, conversation_id, created_at)
    VALUES (?, ?, 'user', ?, ?, ?, ?, ?, datetime('now'))
  `).run(messageId, agentId, modelContent, attachments ? JSON.stringify(attachments) : null, source ?? null, dashMeta, conversationId);

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

  // NOTE (duplicate-work root fix): we deliberately do NOT preempt the running
  // turn here. preemptAgentForUrgentMessage aborts the in-flight turn so the new
  // message can run sooner — but the abort lands AFTER the turn has already
  // committed side effects (created a tracker project, written a deliverable file)
  // and BEFORE it marks its work served. The re-triggered turn then redid that
  // work from scratch: duplicate offsite projects, "Here's the plan" delivered
  // twice, the same question answered twice. Root cause, confirmed via per-turn
  // LOOP-START/TERMINAL-PERSIST markers: rapid inbound messages preempted a
  // multi-step turn repeatedly, each retry reusing the same turn_number and
  // re-running the committed work. The fix is to let the current turn FINISH:
  // handleMessage's activeRuns guard (below) queues this message as a pending
  // wakeup, and the end-of-turn drain serves it next — one turn at a time, no
  // interrupted-and-redone work. Genuine "stop what you're doing" still works via
  // the explicit stop control (stopAgent), which is the right place for an
  // intentional interrupt. (Speed tradeoff: a follow-up sent mid-task waits for
  // the current task to finish instead of interrupting it — correct over fast.)

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

  // FA-G1 / D-J: this body is untrusted and complex (attachment pointers are
  // persisted into the immutable store and handed to file_read), so it IS
  // validated. safeParse keeps the {ok,error} response local (mirrors the
  // auth route); a malformed shape (e.g. an attachment missing `path`) is
  // rejected with 400 before any DB write instead of persisting a broken
  // "Path: undefined" pointer.
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

// GET /:agentId/messages
chatRouter.get('/:agentId/messages', (c) => {
  const agentId = c.req.param('agentId');
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const before = c.req.query('before'); // cursor: message ID for pagination
  const wordy = c.req.query('wordy') === '1'; // wordy mode also serves own coordination output

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

  // D-A step 7 (history retire): legacy pre-cutover inter-agent rows in `messages`
  // are stamped retired_at (migration 102) so they never surface on the chat
  // feed. All NEW inter-agent traffic lives in inter_agent_messages, so this
  // predicate + the store separation are what now keep A2A out of human chat
  // (the dashboard's user-role 'a2a' visibility overlay was retired alongside).
  // This was the wordy-mode-reload leak: the reload reads straight from here.
  const RETIRED_FILTER = 'retired_at IS NULL';

  // REVERTED 2026-07-06 late night, owner correction: the serving contract is
  // the SIMPLE one. `messages` is the conversation; the client renders visible
  // rows in regular mode, everything in wordy mode, and infinite scroll pages
  // straight back to day one on raw-row cursors. A server-side "visible walk"
  // (briefly added tonight) broke that pagination contract. The blank-chat
  // symptom it chased has a structural cause, agents' own coordination output
  // being persisted into this table at all, and that is fixed at the STORE
  // level (inter-agent turn output persists to inter_agent_messages), not by
  // complicating this route.
  if (wordy) {
    // Wordy mode surfaces the agent's OWN inter-agent coordination output in chat.
    // Constraint (own-output only): the store arm serves inter_agent_messages rows
    // with role IN ('assistant','tool') and this agent_id, its own tool_use /
    // tool_result history from inter-agent turns (D-A step 8). Inbound peer A2A
    // (role='user') and engine rows never enter chat; the Threads lane owns them.
    // That matches the live stream (wordy streams own output; inbound A2A no longer
    // broadcasts on chat:message), so live and reload agree. The messages arm keeps
    // today's predicates and dedups any id already in the store (live-edge backfill
    // parity, mirrors mergedTailQuery). The regular branches below stay byte-
    // identical; wordy is a separate query, not a rewrite of them.
    //
    // The store row NULL-pads the columns rowToMessage reads that the store lacks
    // (token_count, model_id, cost, latency_ms, reasoning_content, inbound_meta),
    // but projects 'a2a' AS source so a NEW own-output store row derives the SAME
    // 'a2a' self origin (the pill) as a LEGACY own-output row (messages, source=
    // 'a2a'). deriveOrigin keys the assistant/tool self-channel off source (see
    // origin.ts); without this, new rows rendered as plain agent text while legacy
    // siblings showed the a2a pill. Serving-only: the model-facing loaders are
    // untouched (byte-identity law).
    const unionSql = `
      SELECT id, agent_id, role, content, token_count, model_id, cost, latency_ms,
             created_at, reasoning_content, attachments, source, source_agent_id,
             a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta,
             origin_kind, origin_intent, rowid AS _rowid, 0 AS _tag
      FROM messages
      WHERE agent_id = @agentId AND ${STOP_MARKER_FILTER} AND ${RETIRED_FILTER}
        AND id NOT IN (SELECT id FROM inter_agent_messages WHERE agent_id = @agentId)
      UNION ALL
      SELECT id, agent_id, role, content, NULL AS token_count, NULL AS model_id, NULL AS cost, NULL AS latency_ms,
             created_at, NULL AS reasoning_content, attachments, 'a2a' AS source, source_agent_id,
             a2a_thread_id, a2a_intent, a2a_requires_response, NULL AS inbound_meta,
             origin_kind, origin_intent, rowid AS _rowid, 1 AS _tag
      FROM inter_agent_messages
      WHERE agent_id = @agentId AND role IN ('assistant','tool')
    `;

    const params: Record<string, unknown> = { agentId, limit: Math.min(limit, 200) };
    let cursorClause = '';
    if (before) {
      // The cursor id can live in EITHER table now, so resolve it to the full
      // merged sort key (created_at, _tag, _rowid): messages first, then the store;
      // 400 on miss (same contract as regular mode). Paging then uses a TUPLE
      // predicate over that key so a coordination burst's same-second siblings
      // across the table boundary are not skipped (a bare created_at < ? would drop
      // them, and many rows land in the same second).
      const cursor = db.prepare(`
        SELECT created_at, 0 AS _tag, rowid AS _rowid FROM messages WHERE id = @before AND agent_id = @agentId
        UNION ALL
        SELECT created_at, 1 AS _tag, rowid AS _rowid FROM inter_agent_messages WHERE id = @before AND agent_id = @agentId
        LIMIT 1
      `).get({ before, agentId }) as { created_at: string; _tag: number; _rowid: number } | undefined;
      if (!cursor) {
        return c.json({ ok: false, error: 'Invalid cursor message ID' }, 400);
      }
      params.cCreated = cursor.created_at;
      params.cTag = cursor._tag;
      params.cRowid = cursor._rowid;
      cursorClause = `WHERE created_at < @cCreated
          OR (created_at = @cCreated AND _tag < @cTag)
          OR (created_at = @cCreated AND _tag = @cTag AND _rowid < @cRowid)`;
    }

    rows = db.prepare(`
      SELECT * FROM (${unionSql})
      ${cursorClause}
      ORDER BY created_at DESC, _tag DESC, _rowid DESC
      LIMIT @limit
    `).all(params) as Array<Record<string, unknown>>;
  } else if (before) {
    // Get the timestamp of the cursor message
    const cursorMsg = db.prepare('SELECT created_at FROM messages WHERE id = ?').get(before) as { created_at: string } | undefined;
    if (!cursorMsg) {
      return c.json({ ok: false, error: 'Invalid cursor message ID' }, 400);
    }

    rows = db.prepare(`
      SELECT * FROM messages
      WHERE agent_id = ? AND created_at < ? AND ${STOP_MARKER_FILTER} AND ${RETIRED_FILTER}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(agentId, cursorMsg.created_at, Math.min(limit, 200)) as Array<Record<string, unknown>>;
  } else {
    rows = db.prepare(`
      SELECT * FROM messages
      WHERE agent_id = ? AND ${STOP_MARKER_FILTER} AND ${RETIRED_FILTER}
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
    // The conversation this turn served. Stamped on the agent's OWN
    // assistant/tool rows at turn end (migration 076 / loop C15) with the human
    // conversation key ('owner', 'imessage:…', 'email:…', …); a background /
    // engine turn (scheduler sync, watcher, tracker-driven surface) leaves it
    // null. The dashboard reads it to hide background-run tool CHIPS in regular
    // mode while keeping user-triggered chips (and all surfaced text) visible.
    // Only the regular SELECT * path carries conv_key; the wordy union omits the
    // column, which is fine because wordy mode renders every chip regardless.
    convKey: (row.conv_key as string | null | undefined) ?? null,
    // Canonical attribution for the dashboard's origin-based classifier
    // (mirrors the memory store + agents route projection).
    origin: deriveOrigin({
      role: row.role as Message['role'],
      content: (row.content as string | null) ?? null,
      source: (row.source as string | null) ?? null,
      sourceAgentId: (row.source_agent_id as string | null) ?? null,
      a2aThreadId: (row.a2a_thread_id as string | null) ?? null,
      a2aIntent: (row.a2a_intent as string | null) ?? null,
      a2aRequiresResponse: (row.a2a_requires_response as number | null) ?? null,
      inboundMeta: (row.inbound_meta as string | null) ?? null,
      originKind: (row.origin_kind as string | null) ?? null,
      originIntent: (row.origin_intent as string | null) ?? null,
    }),
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
    // 1. Archive current conversation to vault (for Dreamer to process later).
    // force=true (FA-V1): new-session is a session-boundary bump like reset_session,
    // so always archive the pre-reset tail even if an earlier unprocessed archive exists.
    const archiveId = archiveAgentConversation(agentId, true);
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
    // Clear per-conversation served tracking so a fresh session doesn't treat
    // pre-reset conversations as already answered.
    try {
      const { clearServedConversations } = await import('../../agent/turn-state.js');
      clearServedConversations(agentId);
    } catch { /* ignore */ }

    // 3. Set session boundary — messages before this are excluded from context
    //    Use SQLite datetime format (not ISO) to match the messages table format
    const now = new Date();
    const boundary = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    // Clear both session-scoped config keys: the stale continuity brief and the
    // scratchpad (session-scoped per its tool docs). Matches agents.ts reset.
    db.prepare("UPDATE agents SET session_started_at = ?, updated_at = ?, config = json_remove(COALESCE(config, '{}'), '$.continuityBrief', '$.scratchpad') WHERE id = ?").run(boundary, boundary, agentId);

    // Carry a fired-but-undelivered reminder/scheduler event across the reset
    // boundary so it survives (engine-event queries gate created_at >=
    // session_started_at). Unclaimed deliverable engine rows only.
    try {
      const { rehomeUnclaimedEngineEvents } = await import('../../agent/v2/counterparty.js');
      rehomeUnclaimedEngineEvents(agentId, boundary);
    } catch { /* best-effort carry-over, never block the reset */ }

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
