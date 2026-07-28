import { Hono } from 'hono';
import { resolveOrCreateConversation } from '../../memory/conversations.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import { getDb } from '../../db/connection.js';
import { SendMessageSchema } from '../../config/schema.js';
import { createLogger } from '../../logger.js';
import { getAgentRuntime } from '../../agent/runtime.js';
import { queueEmbedding } from '../../memory/embeddings.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { archiveAgentConversation } from '../../vault/archive.js';
import { replaceContextItems } from '../../memory/dag.js';
import { broadcast } from '../ws.js';
import type { Message } from '@dojo/shared';
import { deriveOrigin, legacyOriginInputs, NEW_SESSION_DIVIDER} from '@dojo/shared';

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
  // T4/OR4: the ONE channel this ingest is on, named once and then used for BOTH the
  // conversation identity and the row's own `channel` stamp — never re-derived. The old
  // `source` column carried only the voice half of that fact; `channel` carries both
  // (T3-0b §3), and the writer module keeps `source` in step for the compat window.
  const inboundChannel = source === 'voice' ? 'voice' : 'dashboard';
  // P5: the owner's dashboard (and voice) is one conversation per agent.
  const conversationId = resolveOrCreateConversation(agentId, {
    channel: inboundChannel, provider: null, counterpartyId: 'owner', threadRoot: null,
  });
  // The routing facts are stamped IN the insert (OR4: at ingest, from this producer's own
  // meta), so the row is never briefly unstamped: `authorized` is dashMeta's own verdict
  // (the owner's dashboard/voice session), `senderId` is the counterparty identity the
  // conversation just resolved on, and `conversationId` lands in the SAME write.
  insertMessageIfAbsent({
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

  // `retired_at` is DISPLAY SUPPRESSION ONLY (research 07 §2g) and that is all it does
  // here: migration 102 stamped legacy pre-cutover inter-agent rows so they never
  // surface on the chat feed. It is NOT the lane filter — it was doing that job by
  // accident while the lane separation was physical, and T6 gives the job back to the
  // column that owns it. Both predicates survive because they answer different
  // questions: `lane` is WHOSE traffic this is, `retired_at` is whether a row the owner
  // once saw should still be rendered.
  const RETIRED_FILTER = 'retired_at IS NULL';

  // The fail-closed human surface. `chat_messages` IS exactly these two predicates
  // (`WHERE lane = 'owner' AND retired_at IS NULL`), so the regular branches below could
  // read the view instead — but wordy mode must ALSO serve the agent's own a2a output,
  // which the view structurally cannot return, and having two branches read two
  // different surfaces is how the live and reload views drifted apart in the first
  // place. One surface, one pair of predicates, both branches.
  const OWNER_LANE_FILTER = "lane = 'owner'";

  // ⛔ REVERSAL, 2026-07-06 late night, owner correction — DO NOT RE-ATTEMPT (research 16).
  // The serving contract is the SIMPLE one: `messages` is the conversation, the CLIENT
  // renders visible rows in regular mode and everything in wordy mode, and infinite
  // scroll pages straight back to day one on raw-row cursors. A server-side "visible
  // walk" was briefly added and broke that pagination contract.
  // T6 NOTE: this is why the display contract's `display_tier` does NOT become a WHERE
  // clause here. T6's plan step reads "wordy mode becomes SELECT … WHERE with
  // display_tier per 17"; filtering the SERVED set by tier server-side is the reverted
  // mechanism wearing a new column's name. T8 owns the write-side classifier and Sweep E
  // owns what the client does with it; this route's job is one query and one lane
  // predicate, and that is all that changed.
  if (wordy) {
    // Wordy mode surfaces the agent's OWN inter-agent coordination output in chat.
    // Inbound peer A2A (role='user') and engine rows never enter chat; the Threads lane
    // owns them. That matches the live stream, so live and reload agree.
    //
    // T6: ONE query. This was a two-arm UNION over two physical tables with an
    // anti-join dedup and a synthetic `'a2a' AS source` column whose only purpose was
    // to make a store row derive the same self-origin pill as a legacy `messages` row.
    // Both halves of that machinery are gone: the rows are in one table, `lane` carries
    // the fact the synthesis was faking, and the sort key is the insertion key rather
    // than a three-part cross-table collation.
    // requirement preserved: wordy mode serves the owner conversation PLUS the agent's
    // OWN inter-agent output (role IN ('assistant','tool')) and never inbound peer A2A
    // or engine rows — the Threads lane owns those.
    const params: Record<string, unknown> = { agentId, limit: Math.min(limit, 200) };
    let cursorClause = '';
    if (before) {
      // The cursor resolves to the insertion key, which is strictly monotonic — so a
      // coordination burst's same-second siblings can no longer be skipped by a page
      // boundary landing inside one second (the reason the old key needed three parts).
      const cursor = db.prepare(
        'SELECT rowid AS _rowid FROM messages WHERE id = @before AND agent_id = @agentId',
      ).get({ before, agentId }) as { _rowid: number } | undefined;
      if (!cursor) {
        return c.json({ ok: false, error: 'Invalid cursor message ID' }, 400);
      }
      params.cRowid = cursor._rowid;
      cursorClause = 'AND rowid < @cRowid';
    }

    rows = db.prepare(`
      SELECT *, datetime(created_at/1000,'unixepoch') AS created_at, rowid AS _rowid FROM messages
      WHERE agent_id = @agentId AND ${STOP_MARKER_FILTER} AND ${RETIRED_FILTER}
        AND (${OWNER_LANE_FILTER} OR (lane = 'a2a' AND role IN ('assistant','tool')))
        ${cursorClause}
      ORDER BY rowid DESC
      LIMIT @limit
    `).all(params) as Array<Record<string, unknown>>;
  } else if (before) {
    // Same cursor shape as wordy mode: the strictly-monotonic insertion key, so both
    // branches page identically. A `created_at <` cursor could skip a same-second
    // sibling, and second-granular ties are the normal case in a burst.
    const cursorMsg = db.prepare('SELECT rowid FROM messages WHERE id = ?').get(before) as { rowid: number } | undefined;
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
    source: row.lane === 'a2a' ? 'a2a' : row.channel === 'voice' ? 'voice' : null,
    // The conversation this turn served. Stamped on the agent's OWN
    // assistant/tool rows at turn end (migration 076 / loop C15) with the human
    // conversation key ('owner', 'imessage:…', 'email:…', …); a background /
    // engine turn (scheduler sync, watcher, tracker-driven surface) leaves it
    // null. The dashboard reads it to hide background-run tool CHIPS in regular
    // mode while keeping user-triggered chips (and all surfaced text) visible.
    convKey: (row.conv_key as string | null | undefined) ?? null,
    // Canonical attribution for the dashboard's origin-based classifier
    // (mirrors the memory store + agents route projection).
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

    // 4. Insert session marker for the UI divider only. The row's created_at is stamped
    //    by the writer at insert time, which is at-or-after `boundary` (computed a few
    //    lines up), so the divider still lands inside the new session for every
    //    `created_at >= session_started_at` query. The broadcast keeps quoting `boundary`.
    const markerId = uuidv4();

    insertMessageIfAbsent({ id: markerId, agentId, role: 'system', content: NEW_SESSION_DIVIDER });

    // 5. Broadcast the divider so the chat UI updates in real time
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: markerId,
        agentId,
        role: 'system',
        content: NEW_SESSION_DIVIDER,
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
    insertMessageIfAbsent({ id: reorientId, agentId, role: 'system', content: reorientContent });
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
