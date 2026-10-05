// ════════════════════════════════════════════════════════════════════════════
// THE DASHBOARD'S ONE NETWORK DOOR (BACKLOG line 31).
//
// ── WHY THIS IS ITS OWN FILE, AND NOT THE BOTTOM OF `api.ts` ──
// `lib/api.ts` is a CATALOGUE: two and a half thousand lines of roughly one
// function per endpoint. What is in here is a POLICY — how any call to this
// platform is authenticated, what a 401 does, and the promise that a dead
// network arrives as a VALUE instead of a throw. Those are different jobs, and
// the size ratchet on `api.ts` exists precisely to push new code into a leaf file
// rather than let that catalogue absorb it. `api.ts` re-exports everything below,
// so every caller still imports from `lib/api` and `vi.mock('../lib/api')` is
// still the ONE seam that mocks the network for the whole package.
//
// ── WHY A DOOR AT ALL ──
// Sixteen files under `src/` used to call the global `fetch` themselves. Each
// re-typed the same plumbing — read `dojo_token` out of `localStorage`, scrape
// the `csrf` cookie, spread two conditional headers — and each got a slightly
// different subset of it right. Worse, a component whose network call is a bare
// `fetch` has NO SEAM: a test that mounts it either reaches a LIVE server (and
// passes because `:3001` happened to be up, proving nothing) or trips the
// tripwire in `vitest.setup.ts`. That is why `every-major-page-mounts.test.tsx`
// had to weaken itself to an offline `fetch` stub for the whole suite.
//
// So `fetch` is called in exactly ONE place in this package — `throughTheDoor`
// below — and every other site asks one of the four wrappers.
// `src/__tests__/the-dashboard-has-one-network-door.test.ts` holds the rule, and
// it counts BOTH ways: a new direct caller reds it, and so does a second call
// site in here.
//
// ── THE FOUR WRAPPERS, AND WHY FOUR ──
//   `request`      JSON in, `ApiResponse<T>` out. The overwhelming majority.
//   `requestRaw`   the caller needs the `Response` itself — a blob to hand the
//                  browser, or a response HEADER
//                  (`X-Dojo-Export-Resolutions`, `Content-Disposition`) that no
//                  JSON envelope carries.
//   `requestForm`  multipart. The browser must write `Content-Type` itself so the
//                  boundary matches the body, so this door must NOT set it.
//   `fetchUrl`     a URL the SERVER handed us (a canvas `inlineUrl`, an office
//                  `renderUrl`, a voice chime) rather than an `/api` path we built.
//
// ── NOTHING ESCAPES AS A REJECTION ──
// Every wrapper returns its failure as a VALUE. A loader that forgets `.catch` is
// then a rendering bug its own page can see, not an unhandled rejection that
// leaves the owner staring at a list which silently never arrives — which is
// exactly what `pages/Techniques.tsx` and `pages/Settings.tsx` did.
// ════════════════════════════════════════════════════════════════════════════

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

/**
 * The headers every call to our own API carries. `json` is false for the doors
 * whose body sets its own type (multipart, a raw `File`); a caller may still
 * override any of them, which is how `application/octet-stream` gets through.
 */
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
  // CSRF token for state-changing requests
  if (MUTATING.includes(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
  }
  return headers;
};

/**
 * THE ONLY `fetch` CALL IN THE DASHBOARD. A dead network becomes a VALUE here, so
 * no caller can leak it as an unhandled rejection.
 */
const throughTheDoor = async (url: string, init: RequestInit): Promise<RawResult> => {
  try {
    return { ok: true, response: await fetch(url, init) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
};

/**
 * An expired session bounces to /login — except when ALREADY there. The login
 * screen renders the orb, which fetches its quality preference via an authed
 * endpoint that 401s pre-login; an unconditional redirect reloads /login,
 * remounts the orb, fetches again → infinite reload loop. Suppressing the
 * redirect there lets such pre-auth background calls fail quietly, and callers
 * fall back to a cached default.
 */
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
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
  if (!text) {
    return { ok: false, error: `Empty response (status ${response.status})` };
  }
  try {
    return JSON.parse(text) as ApiResponse<T>;
  } catch {
    return { ok: false, error: `Server error (status ${response.status})` };
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

/**
 * For a caller that must read the `Response` itself. The HTTP status is the
 * caller's to judge; what this door guarantees is the auth/CSRF headers, the 401
 * bounce, and that a dead network arrives as `{ ok: false }` rather than a throw.
 */
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

/** Multipart upload — see the `requestForm` note in the header above. */
export const requestForm = async <T>(
  path: string,
  body: FormData,
  options: RequestInit = {},
): Promise<ApiResponse<T>> => {
  const raw = await requestRaw(path, { method: 'POST', ...options, body });
  if (!raw.ok) return { ok: false, error: raw.error };
  return readEnvelope<T>(raw.response);
};

/**
 * A URL THE SERVER HANDED US rather than an `/api` path we built. It still comes
 * through this module so the package keeps ONE mockable network seam;
 * `authorize` adds the bearer token for the endpoints that want it.
 */
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
