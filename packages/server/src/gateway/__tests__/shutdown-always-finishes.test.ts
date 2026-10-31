// Shutdown must reach process.exit on every path. An in-flight response that sent
// its headers and never ends used to hold http.Server.close() open for ever; a
// throw while closing used to leave the process hanging with no exit.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { closeServers, trackRequests } from '../close-servers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
  it('resolves after the grace period even when a response never ends', async () => {
    let headersSent: () => void = () => {};
    const sent = new Promise<void>((r) => { headersSent = r; });
    const { server, wss, port } = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: hi\n\n');
      headersSent();
    });
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.on('data', () => {}); res.on('error', () => {}); });
    req.on('error', () => {});
    await sent;
    const result = await raceDeadline(closeServers(server, wss, { graceMs: 200 }), 2000);
    req.destroy();
    if (result === 'timeout') server.closeAllConnections();
    expect(result).not.toBe('timeout');
  });

  it('resolves quickly with nothing open (default grace does not delay a clean close)', async () => {
    const { server, wss } = await start((_req, res) => res.end('ok'));
    const t0 = Date.now();
    const result = await raceDeadline(closeServers(server, wss), 2000);
    expect(result).not.toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('src/index.ts guards re-entry and its closeServers chain always reaches exit', () => {
    const src = fs.readFileSync(path.resolve(HERE, '../../index.ts'), 'utf-8');
    expect(src).toMatch(/let shuttingDown = false/);
    const at = src.indexOf('closeServers(server as unknown as HttpServer, wss)');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 1500)).toMatch(/\.catch\(/);
  });
});
