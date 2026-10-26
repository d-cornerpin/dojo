// PHASE-0 T12c Step 2 — shutdown must close the gateway before it waits.
//
// `main()`'s shutdown called `server.close()` and put the rest of the teardown
// (closeDb, process.exit) inside its callback. `http.Server.close()` stops
// accepting NEW connections but waits for every OPEN one to end — an upgraded
// WebSocket socket is an open connection, and a dashboard keep-alive HTTP
// connection is one too, so with either alive the callback never runs and the
// supervisor SIGKILLs the process, skipping the cleanup inside it.
//
// The fix extracts the gateway teardown into `closeServers()` so it can be
// proven WITHOUT booting the real Dojo: a plain http server + ws server on
// port 0, a keep-alive connection and a WebSocket client, and the function
// must resolve promptly while an in-flight request is allowed to finish.

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { closeServers } from '../close-servers.js';

function startGateway(): { server: http.Server; wss: WebSocketServer; slowRequested: Promise<void> } {
  let onSlow: (() => void) | null = null;
  const slowRequested = new Promise<void>((resolve) => { onSlow = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      // Signal that the /slow request ARRIVED — the connection is established and
      // mid-request, not still in the listen backlog where `server.close()` could
      // refuse it. The response stays pending ~120ms, so this is the in-flight one.
      onSlow?.();
      setTimeout(() => res.end('slow-done'), 120);
    } else {
      res.end('ok');
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return { server, wss, slowRequested };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('gateway has no port');
  return addr.port;
}

/** A keep-alive HTTP request whose socket stays open (idle) after the response. */
function openKeepAlive(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', agent: new http.Agent({ keepAlive: true }) },
      (res) => {
        res.resume();
        res.on('end', () => resolve(req.socket));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

function openWebSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
}

describe('closeServers — the gateway is closed before shutdown waits', () => {
  it('closes an idle keep-alive connection and a WebSocket client, promptly', async () => {
    const { server, wss } = startGateway();
    const port = await listen(server);

    const keepAlive = await openKeepAlive(port);
    const keepAliveClosed = new Promise<void>((resolve) => keepAlive.once('close', () => resolve()));
    const ws = await openWebSocket(port);
    const wsClosed = new Promise<void>((resolve) => ws.once('close', () => resolve()));

    const started = Date.now();
    await closeServers(server, wss);
    const elapsed = Date.now() - started;

    await keepAliveClosed;
    await wsClosed; // the client's own close event — readyState is CLOSED by now
    expect(keepAlive.destroyed, 'the keep-alive connection stayed open').toBe(true);
    expect(ws.readyState, 'the WebSocket client stayed open').toBe(WebSocket.CLOSED);
    expect(elapsed, 'closeServers took too long').toBeLessThan(1_000);
  });

  it('lets an in-flight request finish and still resolves promptly', async () => {
    const { server, wss, slowRequested } = startGateway();
    const port = await listen(server);

    // An in-flight keep-alive request to /slow (response ~120ms later) — the
    // dashboard talks keep-alive, so this is the realistic open-connection case.
    const inFlightDone = new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/slow', agent: new http.Agent({ keepAlive: true }) },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.once('error', reject);
      req.end();
    });

    // Wait for the server to RECEIVE the /slow request before closing: the request
    // is established and mid-flight (response pending), not still in the listen
    // backlog where `server.close()` would refuse the new connection.
    await slowRequested;

    let resolvedEarly = false;
    const closing = closeServers(server, wss).then(() => { resolvedEarly = true; });

    await inFlightDone; // the in-flight response completed
    expect(resolvedEarly, 'closeServers resolved before the in-flight request finished').toBe(false);
    await closing;
  });
});
