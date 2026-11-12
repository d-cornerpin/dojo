import type { Server, ServerResponse } from 'node:http';
import type { WebSocketServer } from 'ws';

// Responses being sent; their connections close after the response so server.close() is not held open.
const inFlight = new Set<ServerResponse>();

let closing = false;

// writeHead(status, {headers}) does not populate getHeader, so the content type is captured here.
const eventStreams = new WeakSet<ServerResponse>();

function noteEventStream(res: ServerResponse): void {
  const orig = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse;
  (res as unknown as { writeHead: (...a: unknown[]) => ServerResponse }).writeHead = (...args: unknown[]) => {
    const hdrs = args.find((a) => a && typeof a === 'object' && !Array.isArray(a)) as Record<string, unknown> | undefined;
    const fromObj = hdrs && Object.entries(hdrs).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    const type = String(fromObj ?? res.getHeader('content-type') ?? '').toLowerCase();
    if (type.includes('text/event-stream')) eventStreams.add(res);
    return orig(...args);
  };
}

function isEventStream(res: ServerResponse): boolean {
  return eventStreams.has(res) || String(res.getHeader('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

/** Track in-flight responses for closeServers. Call once right after creating the server. */
export function trackRequests(httpServer: Server): void {
  // Runs first so `Connection: close` is set while headers are unsent (setHeader throws after).
  httpServer.prependListener('request', (req, res) => {
    inFlight.add(res);
    noteEventStream(res);
    res.once('close', () => inFlight.delete(res));
    if (closing) res.setHeader('Connection', 'close');
  });
}

/** Order matters: ws clients, then idle keep-alives, then server.close() waits only on in-flight requests. */
export async function closeServers(httpServer: Server, wsServer: WebSocketServer): Promise<void> {
  closing = true;

  // In noServer mode wss.close() only waits for clients to leave on their own, so terminate them.
  for (const client of wsServer.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));

  for (const res of inFlight) {
    // An event stream is open by design and carries no unfinished work (clients reconnect), so destroy it now.
    // Ordinary requests may finish; the supervisor SIGKILL is the backstop for a hung one.
    if (res.headersSent && isEventStream(res)) {
      res.socket?.destroy();
    } else if (res.headersSent) {
      res.once('finish', () => res.socket?.end());
    } else {
      res.setHeader('Connection', 'close');
    }
  }

  httpServer.closeIdleConnections();

  await new Promise<void>((resolve) => httpServer.close(() => resolve()));

  closing = false;
}
