// ════════════════════════════════════════
// VNC WebSocket Bridge
// A pipe between a browser noVNC client (binary WebSocket) and the local macOS
// Screen Sharing server (TCP localhost:5900). Authenticated by the dojo JWT
// (?token=) AND gated on the feature being enabled.
//
// The dojo stores NO password. The user sets a VNC password in macOS and types
// it in the viewer (the second factor; the dojo login is the first). To use
// noVNC's reliable VNC-password path, the bridge rewrites the RFB security-types
// list so the client is offered ONLY VNC password auth (type 2), instead of
// macOS's Apple/ARD auth (type 30), which noVNC implements poorly.
// ════════════════════════════════════════

import net from 'node:net';
import jwt from 'jsonwebtoken';
import type { WSContext } from 'hono/ws';
import { getJwtSecret } from '../config/loader.js';
import { createLogger } from '../logger.js';
import { isScreenShareEnabled } from './manager.js';

const logger = createLogger('screen-share-bridge');
const VNC_PORT = 5900;
const VNC_AUTH_TYPE = 2; // classic VNC password auth

function userIdFromUrl(reqUrl: string): string | null {
  try {
    const token = new URL(reqUrl, 'http://localhost').searchParams.get('token');
    if (!token) return null;
    const payload = jwt.verify(token, getJwtSecret()) as { userId: string };
    return payload.userId;
  } catch {
    return null;
  }
}

function toBuffer(data: unknown): Buffer | null {
  if (typeof data === 'string') return null; // RFB is binary; ignore stray text
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  return null;
}

// Per-connection bridge (the factory runs once per WebSocket). Exposes simple
// methods so the Hono handler literal in server.ts stays typed against Hono.
export function createVncBridge(reqUrl: string) {
  let tcp: net.Socket | null = null;
  let userId = '';

  // Server->client handshake rewrite: pass the 12-byte ProtocolVersion, then
  // rewrite the security-types list to offer ONLY type 2. After that, the bridge
  // is a transparent pipe.
  let hsPhase: 'version' | 'sectypes' | 'done' = 'version';
  let hsBuf = Buffer.alloc(0);

  const sendBin = (ws: WSContext, data: Buffer) => {
    try { ws.send(new Uint8Array(data)); } catch { /* client gone */ }
  };

  const handleServerData = (ws: WSContext, chunk: Buffer) => {
    if (hsPhase === 'done') { sendBin(ws, chunk); return; }
    hsBuf = Buffer.concat([hsBuf, chunk]);

    if (hsPhase === 'version') {
      if (hsBuf.length < 12) return;
      sendBin(ws, hsBuf.subarray(0, 12));
      hsBuf = hsBuf.subarray(12);
      hsPhase = 'sectypes';
    }

    if (hsPhase === 'sectypes') {
      if (hsBuf.length < 1) return;
      const count = hsBuf[0];
      if (count === 0) {
        // Server-side handshake failure (count 0, then a reason string) — pass through.
        sendBin(ws, hsBuf);
        hsBuf = Buffer.alloc(0);
        hsPhase = 'done';
        return;
      }
      if (hsBuf.length < 1 + count) return; // wait for the full list
      const types = hsBuf.subarray(1, 1 + count);
      const rest = hsBuf.subarray(1 + count);
      if (types.includes(VNC_AUTH_TYPE)) {
        sendBin(ws, Buffer.from([1, VNC_AUTH_TYPE]));
        logger.info('VNC bridge: offering VNC password auth only (type 2)', { userId, serverOffered: Array.from(types) });
      } else {
        sendBin(ws, hsBuf.subarray(0, 1 + count));
        logger.warn('VNC bridge: VNC password auth not offered by macOS; passing types through', { userId, serverOffered: Array.from(types) });
      }
      hsPhase = 'done';
      hsBuf = Buffer.alloc(0);
      if (rest.length > 0) sendBin(ws, rest);
    }
  };

  const teardown = () => {
    if (tcp) {
      try { tcp.destroy(); } catch { /* ignore */ }
      tcp = null;
    }
  };

  return {
    open(ws: WSContext): void {
      if (!isScreenShareEnabled()) {
        ws.close(1008, 'Screen sharing is disabled');
        return;
      }
      const uid = userIdFromUrl(reqUrl);
      if (!uid) {
        ws.close(1008, 'Authentication required');
        return;
      }
      userId = uid;

      tcp = net.connect(VNC_PORT, '127.0.0.1');
      tcp.on('data', (chunk: Buffer) => handleServerData(ws, chunk));
      tcp.on('close', () => {
        try { ws.close(1000, 'VNC closed'); } catch { /* ignore */ }
      });
      tcp.on('error', (err) => {
        logger.warn('VNC socket error', { error: err instanceof Error ? err.message : String(err), userId });
        try { ws.close(1011, 'VNC connection failed'); } catch { /* ignore */ }
        teardown();
      });
      logger.info('VNC bridge opened', { userId });
    },

    message(data: unknown): void {
      if (!tcp) return;
      const buf = toBuffer(data);
      if (buf) tcp.write(buf);
    },

    close(): void {
      teardown();
      logger.info('VNC bridge closed', { userId });
    },

    error(err: unknown): void {
      logger.warn('VNC bridge WS error', { error: err instanceof Error ? err.message : String(err), userId });
      teardown();
    },
  };
}
