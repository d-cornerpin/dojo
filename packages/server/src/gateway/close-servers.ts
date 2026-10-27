import type { Server, ServerResponse } from 'node:http';
import type { WebSocketServer } from 'ws';

// The responses the gateway is currently sending. `closeServers` marks each one
// so that when its response finishes the connection is closed instead of going
// back to idle keep-alive, which would hold `server.close()` open until the
// keep-alive timeout and let the supervisor SIGKILL the process before the
// cleanup inside it runs.
const inFlight = new Set<ServerResponse>();

// True once shutdown has begun. A request that arrives while it is true is told
// `Connection: close` so it cannot keep its connection alive after the response.
let closing = false;

/**
 * Track the gateway's in-flight responses so `closeServers` can close their
 * connections when it shuts down. Call this once, right after the server is
 * created: a single `'request'` listener records each response and removes it
 * when its connection closes.
 */
export function trackRequests(httpServer: Server): void {
  // Run before the server's own request handler so `Connection: close` can be
  // set while the response headers are still unsent — `res.setHeader` throws
  // once the handler has written them.
  httpServer.prependListener('request', (req, res) => {
    inFlight.add(res);
    res.once('close', () => inFlight.delete(res));
    if (closing) res.setHeader('Connection', 'close');
  });
}

/**
 * Close the gateway's HTTP server and its WebSocket server, in the order that
 * lets `server.close()` finish instead of waiting forever.
 *
 * An upgraded WebSocket socket is an open connection to the HTTP server, and
 * `http.Server.close()` waits for every open connection before its callback
 * runs — so a dashboard keep-alive connection or a live WebSocket would hold
 * shutdown's close callback open until the supervisor SIGKILLs the process and
 * the cleanup inside it is skipped. The ws server (created with `noServer:
 * true`) owns its clients, so it has to be closed first; then the idle
 * keep-alive connections are dropped; only then is `server.close()` allowed to
 * wait for any in-flight request, which is the one thing it SHOULD wait for.
 */
export async function closeServers(httpServer: Server, wsServer: WebSocketServer): Promise<void> {
  // Mark the server as closing first: from here on, a request that arrives is
  // told `Connection: close` so it cannot keep its connection alive afterward.
  closing = true;

  // Terminate every WebSocket client first. In `noServer` mode `wss.close()`
  // only waits for clients to close on their own, so they must be ended here.
  for (const client of wsServer.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));

  // For every response still in flight: if its headers are not sent yet, ask for
  // `Connection: close` so the connection closes when the response ends; if they
  // are already sent, end the socket once the response finishes. Either way the
  // connection cannot return to idle keep-alive and hold `server.close()` open.
  for (const res of inFlight) {
    if (res.headersSent) {
      res.once('finish', () => res.socket?.end());
    } else {
      res.setHeader('Connection', 'close');
    }
  }

  // Drop idle keep-alive connections now — they are not mid-request, so
  // `server.close()` would otherwise wait for their keep-alive timeout.
  httpServer.closeIdleConnections();

  // Stop accepting new connections. In-flight requests are allowed to finish;
  // the callback fires once the last connection ends.
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));

  // The server is fully shut down — no new request can reach it, so the closing
  // flag's job is done. Clear it so a fresh gateway (or the next test's server)
  // starts with a clean slate.
  closing = false;
}
