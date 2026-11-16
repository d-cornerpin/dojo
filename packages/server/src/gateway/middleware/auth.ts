import crypto from 'node:crypto';
import type { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../../config/loader.js';
import { isPastFirstRun } from '../../config/setup-state.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('auth-middleware');

// Only this file decides what is reachable without the owner's token; anything not listed takes the token path.

// ALWAYS PUBLIC: each entry authenticates by another means or carries nothing worth protecting.
const ALWAYS_PUBLIC_PATHS = [
  '/api/auth/login',         // mints the token; bcrypt against the stored hash is the auth
  '/api/health',             // liveness only, no data
  '/api/setup/status',       // three booleans; the login screen reads it pre-token, so never OOBE-only
  '/api/microsoft/callback', // OAuth redirect; the handler verifies the state token
  '/api/google/callback',    // OAuth redirect; ditto (google/auth.ts getFlowForState)
];

const ALWAYS_PUBLIC_PREFIXES = [
  '/api/upload/download/',    // unguessable UUID is the credential
  '/api/voice/assets/',       // static voice-mode runtime assets (VAD model, ORT wasm)
  '/api/twilio/webhook/',     // verified by X-Twilio-Signature in the handler (verifySignatureOr401)
  '/api/twilio/voice-stream', // Twilio Media Streams WS; admits only a call the signed voice webhook announced
];

// OOBE ONLY: open until first run completes. These routes install software and provision the first agent,
// so they must never be reachable on a finished box (the migration router lives only at /api/migration).
const OOBE_ONLY_PREFIXES = [
  '/api/setup/',
];

// The only paths where `Upgrade: websocket` skips token auth; each route authenticates in its own upgrade
// handler (ws.ts verifyAndTrackClient, voice and vnc handlers), registered in gateway/server.ts.
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


const SESSION_S = 30 * 86400;
const RENEW_AFTER_S = 86400;

/** Signs a fresh session token and sets it, with the CSRF token, as the browser's session cookies. */
export function issueSession(c: Context, csrfToken = crypto.randomBytes(32).toString('hex')): { token: string; csrfToken: string } {
  const token = jwt.sign({ userId: 'admin' }, getJwtSecret(), { expiresIn: SESSION_S });
  c.header('Set-Cookie', `token=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_S}`, { append: true });
  c.header('Set-Cookie', `csrf=${csrfToken}; Path=/; SameSite=Strict; Max-Age=${SESSION_S}`, { append: true });
  return { token, csrfToken };
}


export const authMiddleware = async (c: Context, next: Next): Promise<Response | void> => {
  const requestPath = new URL(c.req.url).pathname;

  if (ALWAYS_PUBLIC_PATHS.some(p => requestPath === p)) {
    return next();
  }

  if (ALWAYS_PUBLIC_PREFIXES.some(p => requestPath.startsWith(p))) {
    return next();
  }

  // Open only until first run is finished, then these take the token path.
  if (OOBE_ONLY_PREFIXES.some(p => requestPath.startsWith(p)) && !isPastFirstRun()) {
    return next();
  }

  // WS endpoints authenticate in their own handler, so they are exempted by PATH: the Upgrade header is
  // attacker-controlled and must never buy entry to any other route.
  if (
    WEBSOCKET_PATHS.has(requestPath) &&
    c.req.header('upgrade')?.toLowerCase() === 'websocket'
  ) {
    return next();
  }

  const cookies = parseCookies(c.req.header('Cookie'));
  let token: string | null = null;

  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

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

    const method = c.req.method;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const csrfHeader = c.req.header('X-CSRF-Token');
      const csrfCookie = cookies['csrf'] ?? null;

      // Enforced only when the csrf cookie exists.
      if (csrfCookie && csrfHeader !== csrfCookie) {
        logger.warn('CSRF validation failed', { path: requestPath, method });
        return c.json({ ok: false, error: 'CSRF validation failed' }, 403);
      }
    }

    // A token with less than 29 days left is replaced, so a session in use never reaches its end.
    if (payload.exp - Date.now() / 1000 < SESSION_S - RENEW_AFTER_S) {
      c.header('X-Dojo-Token', issueSession(c, cookies['csrf']).token);
    }

    return next();
  } catch (err) {
    logger.warn('Invalid JWT token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ ok: false, error: 'Invalid or expired token' }, 401);
  }
};
