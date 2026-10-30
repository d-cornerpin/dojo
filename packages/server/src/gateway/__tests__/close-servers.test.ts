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
import { closeServers, trackRequests } from '../close-servers.js';

function startGateway(): {
  server: http.Server;
  wss: WebSocketServer;
  slowRequested: Promise<void>;
  slowFinished: Promise<void>;
} {
  let onSlow: (() => void) | null = null;
  let onFinished: (() => void) | null = null;
  const slowRequested = new Promise<void>((resolve) => { onSlow = resolve; });
  const slowFinished = new Promise<void>((resolve) => { onFinished = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      // Signal that the /slow request ARRIVED — the connection is established and
      // mid-request, not still in the listen backlog where `server.close()` could
      // refuse it. The response stays pending ~120ms, so this is the in-flight one.
      onSlow?.();
      res.once('finish', () => onFinished?.());
      setTimeout(() => res.end('slow-done'), 120);
    } else {
      res.end('ok');
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return { server, wss, slowRequested, slowFinished };
}

/** A gateway whose /gated response is held until the test opens the gate. */
function startGatedGateway(): {
  server: http.Server;
  wss: WebSocketServer;
  gatedRequested: Promise<void>;
  openGate: () => void;
} {
  let onGated: (() => void) | null = null;
  let open: (() => void) | null = null;
  const gatedRequested = new Promise<void>((resolve) => { onGated = resolve; });
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url === '/gated') {
      onGated?.();
      void gate.then(() => res.end('gated-done'));
    } else {
      res.end('ok');
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  return {
    server,
    wss,
    gatedRequested,
    openGate: () => {
      open?.();
      open = null;
    },
  };
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
    trackRequests(server); // populate inFlight, as main() does at boot

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
    const { server, wss, slowRequested, slowFinished } = startGateway();
    const port = await listen(server);
    trackRequests(server);

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

    // The server's own `finish` event is the deterministic completion signal: it
    // fires when the in-flight response is flushed, and only after that does the
    // connection close and `server.close()`'s callback run. The client's `end`
    // event races against that callback, so it cannot prove closeServers waited.
    await slowFinished;
    expect(resolvedEarly, 'closeServers resolved before the in-flight request finished').toBe(false);

    await inFlightDone; // the response also reached the client
    await closing;
  });

  it('does not wait for a keep-alive request that was mid-request when closing began', async () => {
    const { server, wss, gatedRequested, openGate } = startGatedGateway();
    // A real dashboard keep-alive timeout is far longer than the test timeout, so
    // if closeServers waits for it the test hangs and vitest fails the suite.
    server.keepAliveTimeout = 60_000;
    const port = await listen(server);
    trackRequests(server);

    // A keep-alive request to /gated whose response is held by the gate — it is
    // mid-request when closing begins, so `closeIdleConnections()` leaves it alone
    // and `server.close()` would wait for the keep-alive timeout unless the
    // response is told `Connection: close`.
    const done = new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/gated', agent: new http.Agent({ keepAlive: true }) },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.once('error', reject);
      req.end();
    });

    await gatedRequested; // the /gated request is established and mid-flight

    const closing = closeServers(server, wss);
    // Open the gate only once closeServers has called server.close() (the server stops listening at that call).
    // By then closeIdleConnections() has already run and this connection counts as busy. Opened any earlier, the
    // response finishes first, the connection is idle when closeIdleConnections() runs, and the test passes without the fix.
    while (server.listening) await new Promise<void>((r) => setImmediate(r));
    openGate(); // let the mid-flight response finish

    await done;
    await closing; // must resolve promptly, not wait for keepAliveTimeout
  });

  it('tells a request that is mid-flight when closing begins Connection: close', async () => {
    const { server, wss, slowRequested } = startGateway();
    const port = await listen(server);
    trackRequests(server);

    // A live WebSocket is terminated by closeServers while the keep-alive /slow
    // request is still mid-flight. The /slow response comes ~120ms later, so the
    // in-flight loop marks it `Connection: close` long before it is sent — that
    // is the response header the client must read.
    const ws = await openWebSocket(port);
    const wsClosed = new Promise<void>((resolve) => ws.once('close', () => resolve()));

    const agent = new http.Agent({ keepAlive: true });
    let header = '';
    const done = new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/slow', agent },
        (res) => {
          header = res.headers.connection ?? '';
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.once('error', reject);
      req.end();
    });

    await slowRequested; // the /slow request is established and mid-flight

    const closing = closeServers(server, wss);

    await done;
    await wsClosed;
    await closing;
    expect(header.toLowerCase(), 'an in-flight request was not told Connection: close').toBe('close');
    expect(ws.readyState, 'the WebSocket client stayed open').toBe(WebSocket.CLOSED);
  });
});
