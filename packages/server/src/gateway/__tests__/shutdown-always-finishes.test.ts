// Shutdown must reach process.exit on every path. An in-flight response that sent
// its headers and never ends used to hold http.Server.close() open for ever; a
// throw while closing used to leave the process hanging with no exit.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { closeServers, trackRequests } from '../close-servers.js';

function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let t: NodeJS.Timeout;
  const timer = new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

async function start(handler: http.RequestListener): Promise<{ server: http.Server; wss: WebSocketServer; port: number }> {
  const server = http.createServer(handler);
  trackRequests(server);
  const wss = new WebSocketServer({ noServer: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, wss, port: (server.address() as net.AddressInfo).port };
}

describe('closeServers always finishes', () => {
  it('an open event stream and an open websocket do not hold shutdown', async () => {
    let headersSent: () => void = () => {};
    const sent = new Promise<void>((r) => { headersSent = r; });
    const { server, wss, port } = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: hi\n\n');
      headersSent();
    });
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.on('data', () => {}); res.on('error', () => {}); });
    req.on('error', () => {});
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.on('error', () => {});
    await Promise.all([sent, new Promise<void>((r) => ws.on('open', () => r()))]);
    const result = await raceDeadline(closeServers(server, wss), 2000);
    req.destroy();
    if (result === 'timeout') server.closeAllConnections();
    expect(result).not.toBe('timeout');
  });

  it('an ordinary in-flight request is allowed to finish', async () => {
    let arrived: () => void = () => {};
    const got = new Promise<void>((r) => { arrived = r; });
    const { server, wss, port } = await start((_req, res) => {
      arrived();
      setTimeout(() => res.end('done'), 150);
    });
    const body = new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
      }).on('error', reject);
    });
    await got;
    await closeServers(server, wss);
    expect(await body).toBe('done');
  });

  it('resolves quickly with nothing open (default grace does not delay a clean close)', async () => {
    const { server, wss } = await start((_req, res) => res.end('ok'));
    const t0 = Date.now();
    const result = await raceDeadline(closeServers(server, wss), 2000);
    expect(result).not.toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
