import type { WSContext } from 'hono/ws';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { WsEvent } from '@dojo/shared';
import { deriveOrigin, BATCHABLE_EVENTS } from '@dojo/shared';
import { readPersistedRow } from '../memory/message-store.js';
import { recordDashboardDelivery } from '../agent/v2/outbound.js';

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
        // Check if client has missed too many pings
        if (client.missedPings >= MAX_MISSED_PINGS) {
          logger.warn('Client missed too many pings, disconnecting', { clientId: id, userId: client.userId, missed: client.missedPings });
          try { client.ws.close(1001, 'Ping timeout'); } catch { /* ignore */ }
          clients.delete(id);
          continue;
        }

        // Send ping
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

// Which event types to coalesce is now part of the shared wire contract
// (EVENT_BATCHABLE / BATCHABLE_EVENTS in @dojo/shared): the batching decision
// lives beside the event union so a new event type forces an explicit choice at
// compile time instead of silently missing this set (FA-G3).

function flushBatch(): void {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  if (batchBuffer.length === 0) return;

  const events = batchBuffer;
  batchBuffer = [];

  // Send all events as individual messages (but batched in time)
  // This prevents the event loop from being blocked by rapid-fire sends
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
  // Snapshot the listener set before iterating. JS Set iteration visits
  // items added during iteration, so without snapshotting a listener that
  // subscribes inside another listener's callback would also receive the
  // in-flight event. That caused the v2.6.8 "Hello hello" double-
  // synthesis bug in voice mode: the proactive watcher's callback set up
  // the burst listener, which then also fired for the same chat:chunk and
  // pushed its content into the splitter a second time.
  for (const fn of [...internalListeners]) {
    try { fn(event); } catch { /* listener errors must not break broadcast */ }
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// THE BROADCAST SEAM (PHASE-1 T9, research 17 §C4)
//
// Every `chat:message` in the platform flows through here, and that is the whole reason
// this function exists. There are 70 emission sites (measured at HEAD:
// `git grep -nP "type:\s*'chat:message'" -- packages/server/src | wc -l`), and almost all
// of them hand-build a partial `Message` literal — role, content, and a fresh
// `new Date().toISOString()`. Nothing made that literal agree with the row that was
// actually stored, and research 17 traced twelve live-view-vs-reload divergences to
// exactly that gap.
//
// The seam already existed for ONE fact (attribution: `deriveOrigin`). T9 widens it to the
// row itself: look the emission up by its own id and stamp what the database holds.
//
// What that fixes, at all 70 sites at once rather than site by site:
//   · D7 — two `createdAt` formats. The broadcast said `2026-07-28T09:00:00.000Z`, the
//     reload route said `2026-07-28 09:00:00`, and the client compared them as strings.
//     Both paths now carry the route's projection, plus epoch-ms on `row` with no format
//     to get wrong.
//   · D3 + the T8 mood gap — the streamed/in-memory string is not what was persisted.
//     T8 moved the orb mood marker into its own column at INSERT, so the engine's
//     in-memory copy still carried `((mood: calm))` while the row did not. `content` now
//     comes off the row.
//   · display_kind / display_tier had no production reader at all. They have one here,
//     which is what lets the phase exit flip the orphan gate.
//
// An emission with NO row is REPORTED, not silently shipped as if it had one: that is a
// site that broadcasts without persisting, and the kit's BROADCAST_EQUALS_ROW fails on it.
// It is a `warn`, never an `error` — a missing row must not itself take the box down, and
// the invariant is where enforcement belongs.
//
// `interagent:message` takes the same treatment. It carries the same two facts from the
// same rows (the Inter-Agent lane's history route reads `lane IN ('a2a','events')` out of
// `messages`), and its three emitters built `new Date().toISOString()` too — so D7 was
// live in the Threads lane as well. Only `chat:message` gets the `row` field; the lane's
// payload is deliberately self-sufficient and does not classify by tier.
//
// Returns its verdict so the behaviour is unit-testable without a socket.
// ════════════════════════════════════════════════════════════════════════════════
export function stampPersistedRow(event: WsEvent): 'stamped' | 'orphan' | 'not-chat-message' {
  if (event.type !== 'chat:message' && event.type !== 'interagent:message') return 'not-chat-message';
  const msg = event.message;
  if (!msg) return 'not-chat-message';

  let row = null as ReturnType<typeof readPersistedRow>;
  try {
    row = readPersistedRow(msg.id);
  } catch (err) {
    // No database yet (boot, tests) — the emission still goes out; it simply carries no
    // row, and says so.
    logger.debug('chat:message row lookup unavailable', {
      messageId: msg.id, error: err instanceof Error ? err.message : String(err),
    });
  }

  if (row) {
    // The row is the authority for both of these. Everything else on the literal (convKey,
    // attachments, modelId, the live `source` flag) is left as the site set it: those are
    // either live-only facts or facts a separately-owned task is still moving onto the row
    // (the teardown-only conv_key is research 17 §C2, and it is NOT T9's — changing it here
    // would regress the owner-reported "tool chips vanish" bug in the live direction).
    msg.content = row.content;
    msg.createdAt = row.createdAtText;
  } else {
    logger.warn(`${event.type} broadcast with NO persisted row (BROADCAST_EQUALS_ROW)`, {
      agentId: event.agentId, messageId: msg.id, role: msg.role,
      preview: (msg.content ?? '').slice(0, 80),
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
      // Attribution, unchanged: deriveOrigin is pure and falls back to marker parsing, so
      // a sparse payload still resolves.
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
  // The persisted row + attribution ride on every chat:message uniformly (see the seam).
  stampPersistedRow(event);

  // PHASE-2 T5: THE DASHBOARD DOOR. The assistant bubble is the most common delivery in the
  // product and recorded nothing at all — research 03 measured `deliveries` at 44 rows of one
  // tool because of it, and `work.done` requires a delivery, so an answered ask rested at
  // `claimed` forever on this path. This runs AFTER the T9 seam and reads only what the seam
  // already attached (`event.row`): it adds no lookup of its own and changes nothing the seam
  // does, so BROADCAST_EQUALS_ROW rides exactly as before. The narrow predicate and its
  // negative controls live in agent/v2/outbound.ts.
  //
  // Deliberately NOT gated on connected clients: a bubble with nobody watching is still the
  // reply the owner reads on reload, and the ledger must not depend on a socket being open.
  recordDashboardDelivery(event);

  // In-process listeners fire even with zero connected clients (e.g. voice sessions
  // that piggyback on chat:chunk events to drive TTS).
  notifyInternalListeners(event);

  if (clients.size === 0) return; // No browser clients, skip serialization

  // Non-batchable events (errors, completions) send immediately
  if (!BATCHABLE_EVENTS.has(event.type)) {
    sendToAll(event);
    return;
  }

  // Batchable events go into the buffer
  batchBuffer.push(event);

  if (!batchTimer) {
    batchTimer = setTimeout(flushBatch, BATCH_INTERVAL_MS);
  }

  // If buffer is getting large, flush immediately
  if (batchBuffer.length >= 20) {
    flushBatch();
  }
}

// ── Status ──

export function getConnectedClientCount(): number {
  return clients.size;
}

export function getWSStatus(): { connections: number; clients: Array<{ id: number; userId: string; connectedAt: number; missedPings: number }> } {
  return {
    connections: clients.size,
    clients: Array.from(clients.values()).map(c => ({
      id: c.id,
      userId: c.userId,
      connectedAt: c.connectedAt,
      missedPings: c.missedPings,
    })),
  };
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

    // Start heartbeat if not running
    startHeartbeat();

    logger.info('WS client connected', { clientId, userId: payload.userId, totalClients: clients.size });

    // Flush any one-time Google re-auth toast queued by the broker migration, so
    // the first dashboard to open after an update reliably sees it (dynamic
    // import avoids a static cycle with the notice module).
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
  // Find client ID for this ws
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
