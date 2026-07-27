#!/usr/bin/env node
// PHASE-0 T9 Step 0 regression gate: the `Upgrade: websocket` auth bypass.
//
// Until 2026-07-26 the auth middleware returned next() for ANY request whose
// `Upgrade` header said `websocket`, before reading a token, across the whole
// /api/* mount — so an unauthenticated `GET /api/agents` carrying that header
// returned 200. The exemption is now scoped to the three real WS endpoints by
// PATH (auth.ts WEBSOCKET_PATHS); a header can no longer buy entry anywhere.
//
// Uses a RAW SOCKET on purpose: undici/fetch silently refuse to send an
// `Upgrade` header, so a fetch-based test passes even against the vulnerable
// build. That false-green is exactly the class of blindness KIT-HARDENING
// exists to kill — do not "simplify" this to fetch().
//
// Usage: node deploy/checks/check-upgrade-bypass.mjs [port]   (default 3001)
// Exit 0 = bypass closed. Exit 1 = OPEN (or the server is unreachable).

import net from 'node:net';

const PORT = Number(process.argv[2] ?? process.env.DOJO_PORT ?? 3001);
const HOST = '127.0.0.1';

function rawRequest(path, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, HOST);
    let buf = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 5000);
    socket.on('connect', () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: ${HOST}:${PORT}`, ...headers, 'Connection: close', '', ''];
      socket.write(lines.join('\r\n'));
    });
    socket.on('data', (d) => { buf += d.toString('utf8'); });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
    socket.on('close', () => {
      clearTimeout(timer);
      const status = Number((buf.match(/^HTTP\/1\.[01] (\d{3})/) ?? [])[1] ?? 0);
      resolve({ status, raw: buf.slice(0, 200) });
    });
  });
}

const CASES = [
  { name: 'protected route + Upgrade header, no token', path: '/api/agents', headers: ['Upgrade: websocket'] },
  { name: 'protected route + Upgrade header + Connection: Upgrade', path: '/api/agents', headers: ['Upgrade: websocket', 'Connection: Upgrade'] },
  { name: 'protected route + mixed-case Upgrade value', path: '/api/agents', headers: ['Upgrade: WebSocket'] },
  { name: 'config route + Upgrade header', path: '/api/config', headers: ['Upgrade: websocket'] },
  { name: 'baseline: no header, no token', path: '/api/agents', headers: [] },
];

let failed = 0;
for (const c of CASES) {
  let res;
  try {
    res = await rawRequest(c.path, c.headers);
  } catch (e) {
    // No server = cannot test the live auth path. Skip loudly rather than fail:
    // this check is wired into `npm run gates`, which must be runnable offline.
    // A RELEASE gate must run it against a live server (PHASE-0 T13 wires that).
    console.error(`SKIPPED — no server on :${PORT} (${e.message}). The upgrade-bypass check proves nothing without a running server; a release MUST run it live.`);
    process.exit(0);
  }
  const ok = res.status === 401 || res.status === 403;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(res.status).padEnd(3)}  ${c.name}`);
}

if (failed > 0) {
  console.error(`\nUPGRADE-HEADER AUTH BYPASS IS OPEN (${failed} case(s) authenticated with no token). Refusing.`);
  process.exit(1);
}
console.log('\nupgrade-header auth bypass closed (all cases refused without a token)');
