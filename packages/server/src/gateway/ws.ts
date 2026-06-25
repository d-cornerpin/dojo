import type { WSContext } from 'hono/ws';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { WsEvent } from '@dojo/shared';
import { deriveOrigin } from '@dojo/shared';

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

// High-frequency event types that should be batched
const BATCHABLE_EVENTS = new Set([
  'chat:chunk',
  'chat:tool_call',
  'chat:tool_result',
  'chat:message',
  'agent:status',
  'log:entry',
  'ollama:status',
]);

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
  // in-flight event. That caused the v2.6.8 "Hello hello David" double-
  // synthesis bug in voice mode: the proactive watcher's callback set up
  // the burst listener, which then also fired for the same chat:chunk and
  // pushed its content into the splitter a second time.
  for (const fn of [...internalListeners]) {
    try { fn(event); } catch { /* listener errors must not break broadcast */ }
  }
}

// Stamp the canonical MessageOrigin onto a chat:message payload if the
// broadcast site didn't already supply one. There are ~70 broadcast sites and
// most build a partial Message literal (role + content, sometimes source);
// computing origin HERE — the single seam every chat:message flows through —
// means the dashboard's origin-based classifier (visibility.ts) gets reliable
// attribution without each site having to remember to attach it. deriveOrigin
// is pure and falls back to marker parsing, so a sparse payload still resolves.
function stampChatMessageOrigin(event: WsEvent): void {
  if (event.type !== 'chat:message') return;
  const msg = event.message;
  if (!msg || msg.origin) return;
  msg.origin = deriveOrigin({
    role: msg.role,
    content: msg.content,
    source: msg.source ?? null,
    sourceAgentId: msg.sourceAgentId ?? null,
    a2aThreadId: msg.a2aThreadId ?? null,
    a2aIntent: msg.a2aIntent ?? null,
    a2aRequiresResponse: msg.a2aRequiresResponse ?? null,
    inboundMeta: msg.inboundMeta ?? null,
  });
}

export function broadcast(event: WsEvent): void {
  // Attribution rides on every chat:message uniformly (see stamp helper).
  stampChatMessageOrigin(event);

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
