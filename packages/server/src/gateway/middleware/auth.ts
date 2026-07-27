import crypto from 'node:crypto';
import type { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../../config/loader.js';
import { isPastFirstRun } from '../../config/setup-state.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('auth-middleware');

// ── The unauthenticated surface, in two lists and no more ──
//
// This file is the ONLY place that decides what may be reached without the
// owner's token. Anything not named below takes the token path, whatever
// headers it claims (see the WEBSOCKET_PATHS note further down for what
// happened the last time a header could buy entry).

// ALWAYS PUBLIC — reachable without a token for the life of the box, because
// each entry either authenticates by another means or carries nothing worth
// authenticating. Every entry states which.
const ALWAYS_PUBLIC_PATHS = [
  '/api/auth/login',         // mints the token; bcrypt against the stored hash IS the auth
  '/api/health',             // liveness only, no data
  '/api/setup/status',       // three booleans; the login screen reads it pre-token to
                             // decide "create password" vs "password", so it can never
                             // become OOBE-only without breaking the way back in
  '/api/microsoft/callback', // OAuth redirect; the handler verifies the state token
  '/api/google/callback',    // OAuth redirect; ditto (google/auth.ts getFlowForState)
];

const ALWAYS_PUBLIC_PREFIXES = [
  '/api/upload/download/',    // unguessable UUID is the credential
  '/api/voice/assets/',       // static voice-mode runtime assets (VAD model, ORT wasm)
  '/api/twilio/webhook/',     // verified by X-Twilio-Signature in the handler (verifySignatureOr401)
  '/api/twilio/voice-stream', // Twilio Media Streams WS — opened by Twilio, no JWT to give
];

// OOBE ONLY — open while the box has genuinely never completed first run, and
// shut the moment it has. These routes install software, pull models, grant
// system permissions and provision the first agent; a fresh machine has no
// credential to present, which is the ONLY reason they are reachable at all.
//
// SECURITY (2026-07-27, PHASE-0 T9): `/api/setup/` used to sit in one flat
// public list with no such condition, so on a finished, internet-reachable box
// anyone could still call them — and the migration router was mounted a SECOND
// time under `/api/setup/migration`, which made "restore this database over
// yours" an unauthenticated request. That mount is gone; the router now lives
// only at `/api/migration`, behind the token, like every other owner surface.
const OOBE_ONLY_PREFIXES = [
  '/api/setup/',
];

// The only paths where an `Upgrade: websocket` request may skip token auth
// here — each authenticates in its own upgrade handler (ws.ts
// verifyAndTrackClient / the voice + vnc handlers). Registered in
// gateway/server.ts. Adding a route here means that route owns its auth.
const WEBSOCKET_PATHS = new Set([
  '/api/ws',
  '/api/ws/voice',
  '/api/screen/vnc',
]);

export interface JwtPayload {
  userId: string;
  iat: number;
  exp: number;
}

// ── Cookie Parsing ──

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      cookies[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return cookies;
}

// ── CSRF Token Generation ──

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ── Auth Middleware ──

export const authMiddleware = async (c: Context, next: Next): Promise<Response | void> => {
  const requestPath = new URL(c.req.url).pathname;

  if (ALWAYS_PUBLIC_PATHS.some(p => requestPath === p)) {
    return next();
  }

  if (ALWAYS_PUBLIC_PREFIXES.some(p => requestPath.startsWith(p))) {
    return next();
  }

  // The out-of-box window: open only until first run is finished, then these
  // take the token path like everything else.
  if (OOBE_ONLY_PREFIXES.some(p => requestPath.startsWith(p)) && !isPastFirstRun()) {
    return next();
  }

  // WebSocket upgrades authenticate INSIDE their own handler (ws.ts
  // verifyAndTrackClient reads ?token= and closes 1008 on failure), so the
  // three real WS endpoints are exempted here — BY PATH.
  //
  // SECURITY (2026-07-26, PHASE-0 T9 Step 0): this used to exempt ANY request
  // carrying `Upgrade: websocket`, on the whole /api/* mount, before any token
  // was read — so `GET /api/agents` with that one header returned 200 with no
  // credentials at all (verified live against the running dev server, and the
  // box was publicly tunneled at the time). The header is attacker-controlled;
  // the path is not. Anything that is not a WS endpoint now takes the normal
  // token path regardless of what headers it claims.
  if (
    WEBSOCKET_PATHS.has(requestPath) &&
    c.req.header('upgrade')?.toLowerCase() === 'websocket'
  ) {
    return next();
  }

  const cookies = parseCookies(c.req.header('Cookie'));
  let token: string | null = null;

  // Check Authorization header first (for backwards compatibility)
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // Fall back to httpOnly cookie
  if (!token) {
    token = cookies['token'] ?? null;
  }

  if (!token) {
    return c.json({ ok: false, error: 'Authentication required' }, 401);
  }

  try {
    const secret = getJwtSecret();
    const payload = jwt.verify(token, secret) as JwtPayload;
    c.set('userId', payload.userId);

    // CSRF validation for state-changing methods
    const method = c.req.method;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const csrfHeader = c.req.header('X-CSRF-Token');
      const csrfCookie = cookies['csrf'] ?? null;

      // Only enforce CSRF if the csrf cookie exists (allows gradual migration)
      if (csrfCookie && csrfHeader !== csrfCookie) {
        logger.warn('CSRF validation failed', { path: requestPath, method });
        return c.json({ ok: false, error: 'CSRF validation failed' }, 403);
      }
    }

    // Refresh cookie maxAge on each authenticated request (sliding session)
    c.header('Set-Cookie', `token=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`, { append: true });

    return next();
  } catch (err) {
    logger.warn('Invalid JWT token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ ok: false, error: 'Invalid or expired token' }, 401);
  }
};
