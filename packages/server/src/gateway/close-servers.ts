import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';

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
  // Terminate every WebSocket client first. In `noServer` mode `wss.close()`
  // only waits for clients to close on their own, so they must be ended here.
  for (const client of wsServer.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));

  // Drop idle keep-alive HTTP connections now — they are not mid-request, so
  // `server.close()` would otherwise wait for their keep-alive timeout.
  httpServer.closeIdleConnections();

  // Stop accepting new connections. In-flight requests are allowed to finish;
  // the callback fires once the last connection ends.
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));

  // After the in-flight requests above have ended, close whatever remain — a
  // keep-alive connection that finished its request becomes idle again, and if
  // it was not covered by `closeIdleConnections` (it was mid-request then) it
  // would hold `server.close()` open forever. This is the safety net.
  httpServer.closeAllConnections();
}
