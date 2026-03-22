import { Hono } from 'hono';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getJwtSecret, getDashboardPasswordHash, setDashboardPassword } from '../../config/loader.js';
import { LoginSchema, ChangePasswordSchema } from '../../config/schema.js';
import { generateCsrfToken } from '../middleware/auth.js';
import { createLogger } from '../../logger.js';
import type { AppEnv } from '../server.js';

const logger = createLogger('auth');

const SALT_ROUNDS = 12;
const JWT_EXPIRY = '24h';

const authRouter = new Hono<AppEnv>();

// POST /login
authRouter.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'Password is required' }, 400);
  }

  const { password } = parsed.data;
  const storedHash = getDashboardPasswordHash();

  // First-run: no password set yet — set it now
  if (!storedHash) {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    setDashboardPassword(hash);
    logger.info('Initial dashboard password set');

    const secret = getJwtSecret();
    const token = jwt.sign({ userId: 'admin' }, secret, { expiresIn: JWT_EXPIRY });
    const csrfToken = generateCsrfToken();

    c.header('Set-Cookie', `token=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`, { append: true });
    c.header('Set-Cookie', `csrf=${csrfToken}; Path=/; SameSite=Strict; Max-Age=86400`, { append: true });
    return c.json({ ok: true, data: { token, csrfToken } });
  }

  // Verify password
  const valid = await bcrypt.compare(password, storedHash);
  if (!valid) {
    logger.warn('Failed login attempt');
    return c.json({ ok: false, error: 'Invalid password' }, 401);
  }

  const secret = getJwtSecret();
  const token = jwt.sign({ userId: 'admin' }, secret, { expiresIn: JWT_EXPIRY });
  const csrfToken = generateCsrfToken();

  c.header('Set-Cookie', `token=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`, { append: true });
  c.header('Set-Cookie', `csrf=${csrfToken}; Path=/; SameSite=Strict; Max-Age=86400`, { append: true });
  logger.info('Successful login');
  return c.json({ ok: true, data: { token, csrfToken } });
});

// POST /change-password
authRouter.post('/change-password', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ChangePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'Current password and new password (min 8 chars) required' }, 400);
  }

  const { currentPassword, newPassword } = parsed.data;
  const storedHash = getDashboardPasswordHash();

  if (!storedHash) {
    return c.json({ ok: false, error: 'No password set. Use login to set initial password.' }, 400);
  }

  const valid = await bcrypt.compare(currentPassword, storedHash);
  if (!valid) {
    return c.json({ ok: false, error: 'Current password is incorrect' }, 401);
  }

  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  setDashboardPassword(hash);

  logger.info('Dashboard password changed');
  return c.json({ ok: true, data: { message: 'Password changed successfully' } });
});

// GET /me
authRouter.get('/me', (c) => {
  const userId = c.get('userId') ?? 'admin';
  return c.json({ ok: true, data: { authenticated: true, userId } });
});

export { authRouter };
