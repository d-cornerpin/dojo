// ════════════════════════════════════════
// Inter-Agent lane API
//
// The dashboard's dedicated lane for agent-to-agent (A2A) traffic and engine-
// origin notices. D-A kept those rows in their own physical table so they could
// never leak into human chat; Phase 1 moved that separation into the schema —
// they are `lane IN ('a2a','events')` rows in `messages`, and the human surface
// is the fail-closed `chat_messages` view (`WHERE lane = 'owner'`). This route is
// the lane's history source; the live path is the `interagent:message` WS event.
// Scope is per-recipient-agent (agentId), mirroring the chat history route.
// ════════════════════════════════════════

import { Hono } from 'hono';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import type { InterAgentMessage, MessageRole } from '@dojo/shared';

const logger = createLogger('interagent-routes');

const interAgentRouter = new Hono();

// Resolve an agent id to its display name. Historical rows sometimes stored a
// display name in source_agent_id, so a non-uuid value is usable as-is.
function agentName(db: ReturnType<typeof getDb>, idOrName: string | null, cache: Map<string, string | null>): string | null {
  if (!idOrName) return null;
  if (cache.has(idOrName)) return cache.get(idOrName) ?? null;
  let name: string | null = null;
  try {
    const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(idOrName) as { name?: string } | undefined;
    if (row?.name) name = row.name;
  } catch { /* best effort */ }
  if (!name) name = /^[0-9a-f-]{32,}$/i.test(idOrName) ? null : idOrName;
  cache.set(idOrName, name);
  return name;
}

// A subsystem/service label for an engine-origin row. The engine notice writer
// prefixes the body "[SOURCE: AGENT NOTICE from <Name>] …" (or "[SOURCE: <X> …]");
// prefer that, then fall back to a humanized origin_intent, then a generic label.
function engineSenderLabel(content: string, originIntent: string | null): string {
  const from = content.match(/\[SOURCE:[^\]]*\bfrom ([^\]]+)\]/i);
  if (from?.[1]) return from[1].trim();
  const src = content.match(/^\[SOURCE:\s*([A-Z][A-Z ]+?)(?:\s+(?:FROM|UPDATE|TASK)\b|\])/i);
  if (src?.[1]) {
    const label = src[1].trim();
    return label.charAt(0) + label.slice(1).toLowerCase();
  }
  if (originIntent) return originIntent.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  return 'Engine';
}

interface LaneRow {
  id: string;
  agent_id: string;
  role: string;
  content: string;
  source_agent_id: string | null;
  a2a_thread_id: string | null;
  a2a_intent: string | null;
  a2a_requires_response: number | null;
  attachments: string | null;
  lane: string;
  origin_intent: string | null;
  created_at: string;
}

/** The two non-owner lanes the Threads view exists to show. The route used to be
 *  scoped by reading a different TABLE; it is scoped by the column now. */
const THREADS_LANES = "lane IN ('a2a','events')";

/** Every read below projects exactly this list. */
const LANE_COLS = `id, agent_id, role, content, source_agent_id, a2a_thread_id, a2a_intent,
               a2a_requires_response, attachments, lane, origin_intent, datetime(created_at/1000,'unixepoch') AS created_at`;

function rowToInterAgentMessage(
  db: ReturnType<typeof getDb>,
  row: LaneRow,
  recipientName: string | null,
  cache: Map<string, string | null>,
): InterAgentMessage {
  const isEngine = row.lane === 'events';
  const senderName = isEngine
    ? engineSenderLabel(row.content ?? '', row.origin_intent)
    : agentName(db, row.source_agent_id, cache);
  let attachments: InterAgentMessage['attachments'];
  if (row.attachments) {
    try { attachments = JSON.parse(row.attachments) as InterAgentMessage['attachments']; } catch { attachments = undefined; }
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    role: row.role as MessageRole,
    content: row.content,
    createdAt: row.created_at,
    sourceAgentId: row.source_agent_id ?? null,
    senderName,
    recipientName,
    threadId: row.a2a_thread_id ?? null,
    // Engine notices carry their label in origin_intent; peer A2A in a2a_intent.
    intent: (isEngine ? row.origin_intent : row.a2a_intent) ?? null,
    requiresResponse: row.a2a_requires_response === 1,
    originKind: isEngine ? 'engine' : null,
    attachments,
  };
}

// GET /:agentId, inter-agent messages the agent received, newest-first,
// paginated by a `before` message-id cursor (same idiom as the chat history
// route). Returns { ok, data: InterAgentMessage[] } in chronological order.
interAgentRouter.get('/:agentId', (c) => {
  const agentId = c.req.param('agentId');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 200);
  const before = c.req.query('before'); // cursor: message id for pagination

  const db = getDb();

  const agent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(agentId) as { id: string; name: string } | undefined;
  if (!agent) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  let rows: LaneRow[];
  try {
    if (before) {
      // The cursor is the insertion key. It was a (created_at, rowid) TUPLE because a
      // bare `created_at <` skips the cursor row's same-second siblings at a page
      // boundary, and coordination bursts land several rows in one second; the
      // insertion key is strictly monotonic, so one column says the same thing.
      // 400-on-miss contract unchanged.
      const cursor = db.prepare('SELECT rowid AS _rowid FROM messages WHERE id = ?').get(before) as { _rowid: number } | undefined;
      if (!cursor) {
        return c.json({ ok: false, error: 'Invalid cursor message ID' }, 400);
      }
      rows = db.prepare(`
        SELECT ${LANE_COLS}
        FROM messages
        WHERE agent_id = @agentId AND ${THREADS_LANES} AND rowid < @cRowid
        ORDER BY rowid DESC
        LIMIT @limit
      `).all({ agentId, cRowid: cursor._rowid, limit }) as LaneRow[];
    } else {
      rows = db.prepare(`
        SELECT ${LANE_COLS}
        FROM messages
        WHERE agent_id = ? AND ${THREADS_LANES}
        ORDER BY rowid DESC
        LIMIT ?
      `).all(agentId, limit) as LaneRow[];
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to load inter-agent messages', { agentId, error: msg }, agentId);
    return c.json({ ok: false, error: msg }, 500);
  }

  // Reverse to chronological order (oldest first), matching the chat route.
  rows.reverse();

  const cache = new Map<string, string | null>();
  const data: InterAgentMessage[] = rows.map((row) => rowToInterAgentMessage(db, row, agent.name, cache));
  return c.json({ ok: true, data });
});

export { interAgentRouter };
