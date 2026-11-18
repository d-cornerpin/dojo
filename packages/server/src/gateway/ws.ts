import type { WSContext } from 'hono/ws';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { WsEvent } from '@dojo/shared';
import { deriveOrigin, BATCHABLE_EVENTS } from '@dojo/shared';
import { readPersistedRow } from '../memory/message-store.js';
import { recordDashboardDelivery } from '../agent/v2/outbound.js';
import { turnContext } from '../agent/turn-context.js';
import { afterCommit } from '../db/unit.js';

const logger = createLogger('websocket');

// ── Connection Tracking ──

let nextClientId = 1;

interface ConnectedClient {
  id: number;
  ws: WSContext;
  userId: string;
  connectedAt: number;
  lastPong: number;
  missedPings: number;
}

const clients = new Map<number, ConnectedClient>();

// ── Heartbeat ──

const PING_INTERVAL_MS = 30_000;
const MAX_MISSED_PINGS = 3;

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, client] of clients) {
      try {
        if (client.missedPings >= MAX_MISSED_PINGS) {
          logger.warn('Client missed too many pings, disconnecting', { clientId: id, userId: client.userId, missed: client.missedPings });
          try { client.ws.close(1001, 'Ping timeout'); } catch { /* ignore */ }
          clients.delete(id);
          continue;
        }

        client.ws.send(JSON.stringify({ type: 'ping', ts: now }));
        client.missedPings++;
      } catch {
        clients.delete(id);
      }
    }
  }, PING_INTERVAL_MS);
}

function handlePong(clientId: number): void {
  const client = clients.get(clientId);
  if (client) {
    client.lastPong = Date.now();
    client.missedPings = 0;
  }
}

// ── Broadcast with batching ──

const BATCH_INTERVAL_MS = 50; // Flush batched events every 50ms
let batchBuffer: WsEvent[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

// Which event types to coalesce lives beside the event union in @dojo/shared
// (EVENT_BATCHABLE / BATCHABLE_EVENTS), so a new event type forces an explicit choice.

function flushBatch(): void {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  if (batchBuffer.length === 0) return;

  const events = batchBuffer;
  batchBuffer = [];

  // Send all events as individual messages (but batched in time)
  for (const event of events) {
    sendToAll(event);
  }
}

function sendToAll(event: WsEvent): void {
  const data = JSON.stringify(event);
  for (const [id, client] of clients) {
    try {
      client.ws.send(data);
    } catch {
      clients.delete(id);
    }
  }
}

// ── In-process listeners (used by voice sessions to subscribe to chat:chunk) ──
type EventListener = (e: WsEvent) => void;
const internalListeners = new Set<EventListener>();

export function onBroadcast(fn: EventListener): () => void {
  internalListeners.add(fn);
  return () => internalListeners.delete(fn);
}

function notifyInternalListeners(event: WsEvent): void {
  if (internalListeners.size === 0) return;
  // Snapshot before iterating: a listener that subscribes inside another listener's callback
  // must not also receive the in-flight event.
  for (const fn of [...internalListeners]) {
    try { fn(event); } catch { /* listener errors must not break broadcast */ }
  }
}

// THE BROADCAST SEAM: every `chat:message` and `interagent:message` flows through here. The
// emission is looked up by its own id and stamped from the stored row, so live view and reload agree:
// `content` and `createdAt` come off the row, and `chat:message` also gets `row` (epoch-ms,
// display_kind, display_tier) plus attribution via `deriveOrigin`. The inter-agent payload is
// self-sufficient and carries no `row`.
//
// An emission with no row is reported at `warn` (a site that broadcasts without persisting; the
// BROADCAST_EQUALS_ROW invariant is where enforcement belongs), never an error.
// Returns its verdict so the behaviour is unit-testable without a socket.
export function stampPersistedRow(event: WsEvent): 'stamped' | 'orphan' | 'not-chat-message' {
  if (event.type !== 'chat:message' && event.type !== 'interagent:message') return 'not-chat-message';
  const msg = event.message;
  if (!msg) return 'not-chat-message';

  let row = null as ReturnType<typeof readPersistedRow>;
  try {
    row = readPersistedRow(msg.id);
  } catch (err) {
    // No database yet (boot, tests): the emission still goes out, carrying no row.
    logger.debug('chat:message row lookup unavailable', {
      messageId: msg.id, error: err instanceof Error ? err.message : String(err),
    });
  }

  if (row) {
    // The row is the authority for content and createdAt. Everything else on the literal (convKey,
    // attachments, modelId, live `source`) stays as the site set it; the teardown-only conv_key is not moved here.
    msg.content = row.content;
    msg.createdAt = row.createdAtText;
  } else {
    logger.warn(`${event.type} broadcast with NO persisted row (BROADCAST_EQUALS_ROW)`, {
      agentId: event.agentId, messageId: msg.id, role: msg.role,
    }, event.agentId);
  }

  if (event.type === 'chat:message') {
    const chatMsg = event.message;
    if (row) {
      event.row = {
        seq: row.seq, id: row.id, lane: row.lane,
        displayKind: row.displayKind, displayTier: row.displayTier,
        createdAt: row.createdAt, mood: row.mood,
      };
    }
    if (!chatMsg.origin) {
      // deriveOrigin is pure and falls back to marker parsing, so a sparse payload still resolves.
      chatMsg.origin = deriveOrigin({
        role: chatMsg.role,
        content: chatMsg.content,
        source: chatMsg.source ?? null,
        sourceAgentId: chatMsg.sourceAgentId ?? null,
        a2aThreadId: chatMsg.a2aThreadId ?? null,
        a2aIntent: chatMsg.a2aIntent ?? null,
        a2aRequiresResponse: chatMsg.a2aRequiresResponse ?? null,
        inboundMeta: chatMsg.inboundMeta ?? null,
      });
    }
  }
  return row ? 'stamped' : 'orphan';
}

export function broadcast(event: WsEvent): void {
  // Stream frames carry their turn's kind: the dashboard hides an inter-agent stream by the frame itself.
  if (event.type === 'chat:chunk' || event.type === 'chat:reasoning_chunk' || event.type === 'chat:tool_call' || event.type === 'chat:tool_result') {
    event.turnKind = turnContext(event.agentId)?.kind;
  }
  // The persisted row + attribution ride on every chat:message uniformly (see the seam).
  stampPersistedRow(event);

  // Records the assistant bubble as a delivery. Runs after the seam and reads only `event.row`.
  // Not gated on connected clients: the ledger must not depend on a socket being open.
  recordDashboardDelivery(event);

  // Everything above is a write or decoration. recordDashboardDelivery MUST run inside the caller's
  // unit so a rollback takes the delivery row with it; the emission below waits for commit so no
  // listener hears about a write the database did not keep. Outside a unit afterCommit runs at once.
  afterCommit(() => {
    // In-process listeners fire even with zero connected clients (e.g. voice sessions
    // that piggyback on chat:chunk events to drive TTS).
    notifyInternalListeners(event);

    if (clients.size === 0) return; // No browser clients, skip serialization

    // Non-batchable events (errors, completions) send immediately
    if (!BATCHABLE_EVENTS.has(event.type)) {
      sendToAll(event);
      return;
    }

    batchBuffer.push(event);

    if (!batchTimer) {
      batchTimer = setTimeout(flushBatch, BATCH_INTERVAL_MS);
    }

    if (batchBuffer.length >= 20) {
      flushBatch();
    }
  });
}

// ── Connection Management ──

export function verifyAndTrackClient(ws: WSContext, url: string): boolean {
  let token: string | null = null;
  try {
    const urlObj = new URL(url, 'http://localhost');
    token = urlObj.searchParams.get('token');
  } catch { /* ignore */ }

  if (!token) {
    logger.warn('WS rejected: no token');
    ws.close(1008, 'Authentication required');
    return false;
  }

  try {
    const secret = getJwtSecret();
    const payload = jwt.verify(token, secret) as { userId: string };

    const clientId = nextClientId++;
    const client: ConnectedClient = {
      id: clientId,
      ws,
      userId: payload.userId,
      connectedAt: Date.now(),
      lastPong: Date.now(),
      missedPings: 0,
    };
    clients.set(clientId, client);

    startHeartbeat();

    logger.info('WS client connected', { clientId, userId: payload.userId, totalClients: clients.size });

    // Flush any queued one-time Google re-auth toast so the first dashboard to open sees it
    // (dynamic import avoids a static cycle with the notice module).
    void import('../google/reauth-notice.js').then(m => m.flushPendingGoogleReauthToast()).catch(() => {});

    return true;
  } catch (err) {
    logger.warn('WS rejected: invalid token', { error: err instanceof Error ? err.message : String(err) });
    ws.close(1008, 'Invalid token');
    return false;
  }
}

export function removeClient(ws: WSContext): void {
  for (const [id, client] of clients) {
    if (client.ws === ws) {
      clients.delete(id);
      logger.info('WS client disconnected', { clientId: id, userId: client.userId, totalClients: clients.size });
      break;
    }
  }
}

// Handle incoming messages (pong responses)
export function handleClientMessage(ws: WSContext, data: string): void {
  for (const [id, client] of clients) {
    if (client.ws === ws) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'pong') {
          handlePong(id);
        }
      } catch { /* ignore non-JSON */ }
      break;
    }
  }
}
