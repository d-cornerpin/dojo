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
import { verifyAndTrackClient, removeClient, handleClientMessage } from './ws.js';
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
      const newPath = `/api/${segment}/${realId}${rest}`;

      // Redirect internally by rewriting the URL
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
