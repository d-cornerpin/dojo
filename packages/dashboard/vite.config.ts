import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';

// Voice-mode runtime assets (silero VAD + onnxruntime-web wasm) are served
// by the dojo backend at /api/voice/assets/. That path is proxied through
// vite to the backend in dev and served by the node process in prod —
// either way it never goes through vite's source-module resolver, which
// is what trips ORT's dynamic .mjs import.

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'suppress-ws-proxy-errors',
      configureServer(server) {
        // Suppress EPIPE/ECONNRESET on all upgrade sockets (both HMR and proxy).
        // This must happen on the httpServer 'upgrade' event to catch sockets
        // before Vite's internal proxy handler logs errors from them.
        server.httpServer?.on('upgrade', (_req: IncomingMessage, socket: Socket) => {
          if (!socket.listenerCount('error')) {
            socket.on('error', () => {});
          }
        });

        // Override Vite's built-in logger to suppress the specific
        // "ws proxy socket error" message that Vite prints internally.
        const origError = server.config.logger.error;
        server.config.logger.error = (msg: string, options?: { error?: Error }) => {
          if (typeof msg === 'string' && (msg.includes('ws proxy') || msg.includes('ECONNREFUSED'))) return;
          origError(msg, options);
        };
      },
    },
  ],
  server: {
    port: 3000,
    allowedHosts: true as unknown as string[],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          // Suppress http-proxy errors (ECONNREFUSED before server is up, EPIPE on disconnect)
          proxy.on('error', () => {});
          // Attach error handler to proxy-side WebSocket sockets
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            if (!socket.listenerCount('error')) {
              (socket as Socket).on('error', () => {});
            }
          });
        },
      },
    },
  },
});
