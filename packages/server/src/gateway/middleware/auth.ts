import crypto from 'node:crypto';
import type { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../../config/loader.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('auth-middleware');

// Paths that skip authentication
const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/health',
  '/api/microsoft/callback', // OAuth redirect from Microsoft — no JWT available
];

const PUBLIC_PREFIXES = [
  '/api/setup/',  // All setup routes are public (only useful during first run)
];

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

  // Skip auth for public paths
  if (PUBLIC_PATHS.some(p => requestPath === p)) {
    return next();
  }

  if (PUBLIC_PREFIXES.some(p => requestPath.startsWith(p))) {
    return next();
  }

  // Skip auth for WebSocket upgrade requests (they handle auth separately)
  if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
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
