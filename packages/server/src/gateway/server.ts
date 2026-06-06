import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import fs from 'node:fs';
import path from 'node:path';
import { authMiddleware } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { configRouter } from './routes/config.js';
import { setupRouter } from './routes/setup.js';
import { chatRouter } from './routes/chat.js';
import { uploadRouter } from './routes/upload.js';
import { agentsRouter } from './routes/agents.js';
import { systemRouter } from './routes/system.js';
import { memoryRouter } from './routes/memory.js';
import { trackerRouter } from './routes/tracker.js';
import { routerRouter } from './routes/router.js';
import { costsRouter } from './routes/costs.js';
import { servicesRouter } from './routes/services.js';
import { techniquesRouter } from './routes/techniques.js';
import { controlRouter } from './routes/control.js';
import { setupDepsRouter } from './routes/setup-deps.js';
import { groupsRouter } from './routes/groups.js';
import { taskRunsRouter } from './routes/task-runs.js';
import { vaultRouter } from './routes/vault.js';
import { updateRouter } from './routes/update.js';
import { googleRouter } from './routes/google.js';
import { microsoftRouter } from './routes/microsoft.js';
import { plaudRouter } from './routes/plaud.js';
import { credentialsRouter } from './routes/credentials.js';
import { contactsRouter } from './routes/contacts.js';
import { migrationRouter } from './routes/migration.js';
import { healerRouter } from './routes/healer.js';
import { verifyAndTrackClient, removeClient, handleClientMessage } from './ws.js';
import { verifyAndOpenVoiceSession, closeVoiceSession, handleVoiceMessage } from '../voice/voice-ws.js';
import { voiceAssetsRouter } from '../voice/voice-assets.js';
import { voiceRouter } from '../voice/voice-routes.js';
import { getPrimaryAgentId, getPMAgentId } from '../config/platform.js';
import { createLogger } from '../logger.js';

const logger = createLogger('server');

// Shared Hono env type for all routes
export type AppEnv = {
  Variables: {
    userId: string;
  };
};

export function createServer() {
  const app = new Hono<AppEnv>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // CORS for development
  app.use('*', cors({
    origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));

  // Public file shares — served unauthenticated so anyone with the slug
  // URL can view (this is the whole point of share_publicly). The slug
  // includes a 28-bit random tag, so URLs are unguessable in practice.
  // We hand-roll the static handler here instead of using serveStatic so
  // we can validate the slug shape and prevent path traversal.
  app.get('/share/:slug/*', async (c) => {
    const fs = (await import('node:fs')).default;
    const path = (await import('node:path')).default;
    const { OUT_DIR } = await import('../services/public-share.js');
    const slug = c.req.param('slug');
    if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
      return c.json({ ok: false, error: 'invalid share slug' }, 400);
    }
    // Hono gives us the rest of the path as `:slug/*` — extract it from the URL.
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    const relMatch = pathname.match(/^\/share\/[^/]+\/(.*)$/);
    const rel = relMatch ? relMatch[1] : '';
    const shareDir = path.join(OUT_DIR, slug);
    const fullPath = rel ? path.join(shareDir, rel) : path.join(shareDir, 'index.html');
    // Block traversal — fullPath must stay inside shareDir.
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(shareDir) + path.sep) && resolved !== path.resolve(shareDir)) {
      return c.json({ ok: false, error: 'invalid path' }, 400);
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return c.json({ ok: false, error: 'not found' }, 404);
    }
    const ext = path.extname(resolved).toLowerCase();
    const mime: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.htm':  'text/html; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
      '.js':   'application/javascript; charset=utf-8',
      '.mjs':  'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.txt':  'text/plain; charset=utf-8',
      '.md':   'text/markdown; charset=utf-8',
      '.svg':  'image/svg+xml',
      '.png':  'image/png',
      '.jpg':  'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif':  'image/gif',
      '.webp': 'image/webp',
      '.pdf':  'application/pdf',
      '.mp4':  'video/mp4',
      '.mov':  'video/quicktime',
      '.webm': 'video/webm',
      '.mp3':  'audio/mpeg',
      '.wav':  'audio/wav',
    };
    const buf = fs.readFileSync(resolved);
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': mime[ext] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=300',
      },
    });
  });

  // Auth middleware (skips public paths)
  app.use('/api/*', authMiddleware);

  // WebSocket endpoint
  app.get('/api/ws', upgradeWebSocket((c) => {
    return {
      onOpen: (_event, ws) => {
        const url = c.req.url;
        verifyAndTrackClient(ws, url);
      },
      onMessage: (event, ws) => {
        if (typeof event.data === 'string') {
          handleClientMessage(ws, event.data);
        }
      },
      onClose: (_event, ws) => {
        removeClient(ws);
      },
      onError: (error, ws) => {
        logger.error('WebSocket error', {
          error: error instanceof Error ? error.message : String(error),
        });
        removeClient(ws);
      },
    };
  }));

  // Voice mode WebSocket — separate endpoint because it carries binary audio
  // frames in both directions and runs its own per-session state machine.
  app.get('/api/ws/voice', upgradeWebSocket((c) => {
    return {
      onOpen: (_event, ws) => {
        verifyAndOpenVoiceSession(ws, c.req.url);
      },
      onMessage: (event, ws) => {
        void handleVoiceMessage(ws, event.data as string | ArrayBuffer | Buffer);
      },
      onClose: (_event, ws) => {
        closeVoiceSession(ws);
      },
      onError: (error, ws) => {
        logger.error('Voice WebSocket error', {
          error: error instanceof Error ? error.message : String(error),
        });
        closeVoiceSession(ws);
      },
    };
  }));

  // Rewrite "primary" and "pm" agent ID aliases to actual configured IDs
  // This lets the dashboard use 'primary' as a default before loading the real ID
  app.use('/api/*', async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;

    // Match patterns like /api/chat/primary/... or /api/agents/primary or /api/memory/primary/...
    const aliasMatch = path.match(/^\/api\/(chat|agents|memory)\/(?:primary|pm)(\/.*)?$/);
    if (aliasMatch) {
      const segment = aliasMatch[1];
      const rest = aliasMatch[2] ?? '';
      const isPm = path.includes('/pm/') || path.endsWith('/pm');
      const realId = isPm ? getPMAgentId() : getPrimaryAgentId();

      // Prevent redirect loop if the real ID is the same as the alias
      if (realId === 'primary' || realId === 'pm') {
        return c.json({ ok: false, error: 'Agent not configured yet' }, 404);
      }

      const newPath = `/api/${segment}/${realId}${rest}`;
      const newUrl = new URL(newPath, url.origin);
      newUrl.search = url.search;
      return c.redirect(newUrl.pathname + newUrl.search, 307);
    }

    return next();
  });

  // Mount route groups
  app.route('/api/auth', authRouter);
  app.route('/api/setup', setupRouter);     // /api/setup/status, /api/setup/password, /api/setup/complete
  app.route('/api/setup', setupDepsRouter); // /api/setup/deps/*, /api/setup/ollama/*, /api/setup/permissions/*
  app.route('/api/config', configRouter); // /api/config/providers/*, /api/config/models/*, /api/config/identity/*
  app.route('/api/chat', chatRouter);     // /api/chat/:agentId/messages
  app.route('/api/upload', uploadRouter); // /api/upload/:agentId, /api/upload/file/:agentId/:filename
  app.route('/api/agents', agentsRouter); // /api/agents, /api/agents/:id
  app.route('/api/memory', memoryRouter); // /api/memory/:agentId/*
  app.route('/api/tracker', trackerRouter); // /api/tracker/projects/*, /api/tracker/tasks/*
  app.route('/api/router', routerRouter);  // /api/router/config, /api/router/test, etc.
  app.route('/api/costs', costsRouter);    // /api/costs/summary, /api/costs/records, etc.
  app.route('/api/system', servicesRouter); // /api/system/watchdog, /api/system/resources, etc.
  app.route('/api/control', controlRouter); // /api/control/mouse-click, /api/control/screen-read, etc.
  app.route('/api/groups', groupsRouter);   // /api/groups, /api/groups/:id
  app.route('/api/techniques', techniquesRouter); // /api/techniques, /api/techniques/:id
  app.route('/api/vault', vaultRouter);     // /api/vault/entries, /api/vault/dream, etc.
  app.route('/api/update', updateRouter);   // /api/update/check, /api/update/apply
  app.route('/api/google', googleRouter);   // /api/google/status, /api/google/connect, etc.
  app.route('/api/microsoft', microsoftRouter); // /api/microsoft/status, /api/microsoft/callback, etc.
  app.route('/api/plaud', plaudRouter);     // /api/plaud/status, /api/plaud/connect, etc.
  app.route('/api/credentials', credentialsRouter); // agent credentials vault CRUD
  app.route('/api/contacts', contactsRouter); // DOJO contacts store CRUD
  app.route('/api/migration', migrationRouter); // /api/migration/export, /api/migration/import, etc.
  app.route('/api/setup/migration', migrationRouter); // Same routes, public for OOBE import
  app.route('/api/healer', healerRouter);   // /api/healer/config, /api/healer/proposals, etc.
  app.route('/api/voice/assets', voiceAssetsRouter); // VAD/ORT static runtime assets
  app.route('/api/voice', voiceRouter);              // voice settings + models + preview
  app.route('/api', taskRunsRouter);        // /api/tasks/:taskId/runs
  app.route('/api', systemRouter);        // /api/health, /api/system/logs

  // In production, serve the built dashboard static files
  if (process.env.NODE_ENV === 'production') {
    const dashboardDist = path.resolve(process.cwd(), 'packages/dashboard/dist');
    if (fs.existsSync(dashboardDist)) {
      // Serve static assets (relative to cwd)
      app.use('/assets/*', serveStatic({ root: './packages/dashboard/dist' }));
      app.use('/favicon.png', serveStatic({ root: './packages/dashboard/dist', path: '/favicon.png' }));
      app.use('/dojologo.svg', serveStatic({ root: './packages/dashboard/dist', path: '/dojologo.svg' }));
      // v2.5.5 — Feng Shui theme files live in dashboard's public/themes/<id>/
      // and are emitted to dist/themes/ at build time. ThemeProvider injects
      // <link href="/themes/<id>/theme.css"> at runtime when the user picks a
      // non-default theme. Without this handler, those requests fall through
      // to the SPA fallback below, which returns index.html — the browser
      // then tries to parse HTML as CSS and silently no-ops the theme switch.
      app.use('/themes/*', serveStatic({ root: './packages/dashboard/dist' }));
      // Voice mode chimes — same trap as the theme.css note above. Without
      // these explicit handlers, /wake-chime.wav etc. fall through to the SPA
      // fallback, which returns index.html, and the browser silently fails to
      // decode HTML as audio. Affects every prod user (tunnel or local).
      app.use('/wake-chime.wav', serveStatic({ root: './packages/dashboard/dist', path: '/wake-chime.wav' }));
      app.use('/sleep-chime.wav', serveStatic({ root: './packages/dashboard/dist', path: '/sleep-chime.wav' }));
      app.use('/prompt-sent.wav', serveStatic({ root: './packages/dashboard/dist', path: '/prompt-sent.wav' }));

      // SPA fallback: serve index.html for all non-API routes
      app.get('*', (c) => {
        if (c.req.path.startsWith('/api/')) {
          return c.json({ ok: false, error: 'Not found' }, 404);
        }
        const indexPath = path.join(dashboardDist, 'index.html');
        if (fs.existsSync(indexPath)) {
          const html = fs.readFileSync(indexPath, 'utf-8');
          return c.html(html);
        }
        return c.json({ ok: false, error: 'Dashboard not found' }, 404);
      });
    }
  }

  // 404 handler
  app.notFound((c) => {
    return c.json({ ok: false, error: 'Not found' }, 404);
  });

  // Global error handler
  app.onError((err, c) => {
    logger.error('Unhandled error', {
      error: err.message,
      path: c.req.url,
      method: c.req.method,
    });
    return c.json({ ok: false, error: 'Internal server error' }, 500);
  });

  return { app, injectWebSocket };
}
