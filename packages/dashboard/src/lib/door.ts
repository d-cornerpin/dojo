// THE DASHBOARD'S ONE NETWORK DOOR: fetch is called in exactly one place here, in `throughTheDoor`,
// and `src/__tests__/the-dashboard-has-one-network-door.test.ts` reds on a second site either way.
// `api.ts` is a catalogue; its size ratchet pushes policy like this into leaf files. It re-exports
// this, so `lib/api` stays the import and `vi.mock('../lib/api')` the one mock seam for the package.

import type { ApiResponse } from '@dojo/shared';

export const BASE_URL = '/api';

export const getToken = (): string | null => localStorage.getItem('dojo_token');

export const setToken = (token: string): void => {
  localStorage.setItem('dojo_token', token);
};

export const clearToken = (): void => {
  localStorage.removeItem('dojo_token');
};

// Read CSRF token from cookie (non-httpOnly, accessible to JS)
function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return match ? match[1] : null;
}

/** A response the caller will read itself, or the reason there is not one. */
export type RawResult =
  | { ok: true; response: Response }
  | { ok: false; error: string };

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** The headers every call to our own API carries. `json` is false when the body sets its own type
 *  (multipart, a raw `File`); a caller may still override any of them. */
const doorHeaders = (
  method: string,
  extra: Record<string, string> | undefined,
  json: boolean,
): Record<string, string> => {
  const headers: Record<string, string> = {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(extra || {}),
  };
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (MUTATING.includes(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
  }
  return headers;
};

const UNREACHABLE = 'The Dojo could not be reached. Check that it is running, then try again.';
const CUT_OFF = 'The Dojo\'s answer was cut off. Try again.';
const EMPTY = 'The Dojo sent back an empty answer. Try again.';
const UNREADABLE = 'The Dojo sent back an answer the dashboard could not read. Try again, or restart the Dojo if it keeps happening.';

/** THE ONLY `fetch` CALL IN THE DASHBOARD. A dead network becomes a VALUE here, never a rejection. */
const throughTheDoor = async (url: string, init: RequestInit): Promise<RawResult> => {
  try {
    const response = await fetch(url, init);
    const renewed = response.headers.get('X-Dojo-Token');   // the server replaced a day-old token
    if (renewed) setToken(renewed);
    return { ok: true, response };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
};

/** An expired session bounces to /login, except when already there: the login orb's authed
 *  fetch 401s pre-login, and an unconditional redirect reloads, remounts and refetches forever.
 *  Suppressing it there lets pre-auth calls fail quietly to their cached default. */
const isUnauthorized = (response: Response, path: string): boolean => {
  if (response.status !== 401 || path.startsWith('/auth/login')) return false;
  if (window.location.pathname !== '/login') {
    clearToken();
    window.location.href = '/login';
  }
  return true;
};

/** Read the JSON envelope off a response the door already holds. */
const readEnvelope = async <T>(response: Response): Promise<ApiResponse<T>> => {
  const status = response.status;
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, error: CUT_OFF, status };
  }
  if (!text) {
    return { ok: false, error: EMPTY, status };
  }
  try {
    const parsed = JSON.parse(text) as ApiResponse<T>;
    return parsed && parsed.ok === false ? { ...parsed, status } : parsed;
  } catch {
    return { ok: false, error: UNREADABLE, status };
  }
};

export const request = async <T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> => {
  const method = options.method?.toUpperCase() ?? 'GET';
  const raw = await throughTheDoor(`${BASE_URL}${path}`, {
    credentials: 'same-origin', // Send cookies with requests; a caller may override
    ...options,
    headers: doorHeaders(method, options.headers as Record<string, string>, true),
  });
  if (!raw.ok) return { ok: false, error: raw.error };
  if (isUnauthorized(raw.response, path)) return { ok: false, error: 'Unauthorized' };
  return readEnvelope<T>(raw.response);
};

/** For a caller that must read the `Response` itself: status is theirs to judge; the door
 *  guarantees auth/CSRF headers, the 401 bounce, and no throw on a dead network. */
export const requestRaw = async (
  path: string,
  options: RequestInit = {},
): Promise<RawResult> => {
  const method = options.method?.toUpperCase() ?? 'GET';
  const raw = await throughTheDoor(`${BASE_URL}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: doorHeaders(method, options.headers as Record<string, string>, false),
  });
  if (!raw.ok) return raw;
  if (isUnauthorized(raw.response, path)) return { ok: false, error: 'Unauthorized' };
  return raw;
};

/** Multipart: the browser must write `Content-Type` itself so the boundary matches the body. */
export const requestForm = async <T>(
  path: string,
  body: FormData,
  options: RequestInit = {},
): Promise<ApiResponse<T>> => {
  const raw = await requestRaw(path, { method: 'POST', ...options, body });
  if (!raw.ok) return { ok: false, error: raw.error };
  return readEnvelope<T>(raw.response);
};

/** A URL THE SERVER HANDED US rather than an `/api` path we built; it still comes through
 *  this module so the package keeps ONE mockable network seam. `authorize` adds the bearer token. */
export const fetchUrl = async (
  url: string,
  options: RequestInit & { authorize?: boolean } = {},
): Promise<RawResult> => {
  const { authorize, ...init } = options;
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
  if (authorize) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  return throughTheDoor(url, { ...init, headers });
};
