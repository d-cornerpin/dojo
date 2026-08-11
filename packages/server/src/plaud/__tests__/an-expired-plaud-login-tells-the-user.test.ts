// ════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T38 — AN EXPIRED PLAUD LOGIN TELLS THE USER, ONCE
//
// OWNER REPORT (post-.27, live box): when the Plaud integration's login
// expires, nothing tells the user; and the Settings card does not explain that
// reconnecting opens a browser ON THE MAC the platform runs on.
//
// ROOT CAUSE. The expiry IS detected — `runPlaudCommand` computes `needsReauth`
// from the CLI's exit code 2 (or its own "not logged in / reauth / sign in
// again" text) and has since the integration was written. The detection is then
// THROWN AWAY at the only place it happens during real use: every one of the
// eight `plaud_*` tools turns it into a sentence for the MODEL
// (`tools-read.ts`) and returns. Nothing flips the stored `plaud_connected`
// flag, so `getPlaudStatus()` keeps reporting connected (the card kept saying
// "Connected as david@cornerp.in since 25 May" — the live box's own config rows
// at the time of this fix), `isPlaudConnected()` keeps offering the tools, and
// the user is told nothing at all. The ONE path that did flip the flag,
// `refreshPlaudAccountInfo()`, is reachable only from `POST /api/plaud/refresh`
// — a route no UI calls. So the expired state was invisible until somebody
// poked an endpoint by hand.
//
// THE SHAPE OF THE FIX, and what these clauses hold:
//   • `notePlaudReauthRequired` is the ONE owner of the expiry transition, and
//     the STORED FLAG IS THE EPISODE LATCH — no new state, no timers, no
//     counters. First failing call flips it and speaks; every later call in the
//     same episode sees it already flipped and says nothing.
//   • it speaks through the EXISTING toast path only (`chat:error` →
//     `Chat.tsx`'s severity switch), at severity `error`, which that switch
//     defines as "stays until dismissed" — the right shape for a login the user
//     must go and renew. No new channel, no new component.
//   • an intentional `logout` that reports "not logged in" is NOT an expiry.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');

// ── The config table, in memory ──
const config = new Map<string, string>();

vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (key: string) => (config.has(key) ? { value: config.get(key) } : undefined),
      run: (...bind: string[]) => {
        if (/^\s*DELETE/i.test(sql)) { config.delete(bind[0]); return; }
        config.set(bind[0], bind[1]);
      },
      all: () => [],
    }),
  }),
}));

const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); } }));
vi.mock('../../agent/tool-config-generation.js', () => ({ bumpToolConfigGeneration: () => undefined }));

// ── The CLI, faked at the process boundary ──
let cliBehaviour: { code: number; stdout: string; stderr: string } = { code: 2, stdout: '', stderr: '' };
vi.mock('node:child_process', () => {
  const execFile = (): void => undefined;
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    async (): Promise<{ stdout: string; stderr: string }> => {
      if (cliBehaviour.code === 0) return { stdout: cliBehaviour.stdout, stderr: cliBehaviour.stderr };
      const err = new Error('Command failed') as Error & { code: number; stdout: string; stderr: string };
      err.code = cliBehaviour.code;
      err.stdout = cliBehaviour.stdout;
      err.stderr = cliBehaviour.stderr;
      throw err;
    };
  return { execFile, spawn: () => ({ on: () => undefined, stdout: null, stderr: null, kill: () => undefined }) };
});

const { runPlaudCommand } = await import('../client.js');
const { getPlaudStatus, isPlaudConnected } = await import('../auth.js');

function connected(): void {
  config.clear();
  config.set('plaud_connected', 'true');
  config.set('plaud_email', 'david@example.com');
  config.set('plaud_connected_at', '2026-05-25T23:02:02.310Z');
}
const toasts = (): Array<Record<string, unknown>> => broadcasts.filter((b) => b.type === 'chat:error');
const disconnects = (): Array<Record<string, unknown>> => broadcasts.filter((b) => b.type === 'plaud:disconnected');

beforeEach(() => {
  broadcasts.length = 0;
  cliBehaviour = { code: 2, stdout: '', stderr: '' };
  connected();
});

describe('an expired Plaud login tells the user, exactly once per episode', () => {
  it('THE RED: the first tool call that hits the expiry flips the stored state and toasts', async () => {
    const out = await runPlaudCommand(['files'], { agentId: 'kevin' });
    expect(out.needsReauth).toBe(true);

    // The stored truth moved: the card and the tool gate both read this.
    expect(config.get('plaud_connected')).toBe('false');
    expect(isPlaudConnected()).toBe(false);

    // ONE toast, on the existing path, at the severity that stays put.
    expect(toasts()).toHaveLength(1);
    const t = toasts()[0];
    expect(t.agentId).toBe('kevin');
    expect(t.severity).toBe('error');
    expect(t.code).toBe('AUTH_INVALID');
    expect(String(t.error)).toMatch(/Plaud/i);
    expect(String(t.error)).toMatch(/Settings/);
    // And the card is told, so it re-reads without a refresh.
    expect(disconnects()).toHaveLength(1);
  });

  it('THE RED, second half: every later failing call in the SAME episode stays quiet', async () => {
    await runPlaudCommand(['files'], { agentId: 'kevin' });
    broadcasts.length = 0;
    await runPlaudCommand(['recent'], { agentId: 'kevin' });
    await runPlaudCommand(['transcript', 'abc'], { agentId: 'kevin' });
    await runPlaudCommand(['me'], { agentId: 'kevin' });
    expect(toasts()).toHaveLength(0);
    expect(disconnects()).toHaveLength(0);
  });

  it('a NEW episode after a reconnect toasts again', async () => {
    await runPlaudCommand(['files'], { agentId: 'kevin' });
    expect(toasts()).toHaveLength(1);
    connected();                       // the user reconnected
    broadcasts.length = 0;
    await runPlaudCommand(['files'], { agentId: 'kevin' });
    expect(toasts()).toHaveLength(1);
  });

  it('the stored email and connected-at SURVIVE the expiry, so the card can name the account', async () => {
    await runPlaudCommand(['files'], { agentId: 'kevin' });
    expect(config.get('plaud_email')).toBe('david@example.com');
    expect(config.get('plaud_connected_at')).toBe('2026-05-25T23:02:02.310Z');
  });

  it('`getPlaudStatus` reports reauthRequired — distinguishable from never-connected', async () => {
    await runPlaudCommand(['files'], { agentId: 'kevin' });
    expect(getPlaudStatus()).toMatchObject({ connected: false, reauthRequired: true, email: 'david@example.com' });

    config.clear();                    // never connected at all
    expect(getPlaudStatus()).toMatchObject({ connected: false, reauthRequired: false });
  });
});

describe('the controls — what must NOT speak', () => {
  it('a NON-reauth failure says nothing and leaves the state alone', async () => {
    cliBehaviour = { code: 1, stdout: '', stderr: 'network unreachable' };
    const out = await runPlaudCommand(['files'], { agentId: 'kevin' });
    expect(out.needsReauth).toBe(false);
    expect(config.get('plaud_connected')).toBe('true');
    expect(toasts()).toHaveLength(0);
  });

  it('an intentional `logout` reporting "not logged in" is not an expiry', async () => {
    cliBehaviour = { code: 2, stdout: '', stderr: 'not logged in' };
    await runPlaudCommand(['logout'], { agentId: 'kevin' });
    expect(toasts()).toHaveLength(0);
    expect(disconnects()).toHaveLength(0);
  });

  it('an expiry detected with NO agent in hand still records the state — it just has no chat to speak in', async () => {
    // `POST /api/plaud/refresh` has no agent context. The transition must still
    // land (the card is the surface there) without inventing an agent id to
    // address a toast to.
    await runPlaudCommand(['me']);
    expect(config.get('plaud_connected')).toBe('false');
    expect(disconnects()).toHaveLength(1);
    expect(toasts()).toHaveLength(0);
  });

  it('a SUCCESSFUL command says nothing', async () => {
    cliBehaviour = { code: 0, stdout: 'ok', stderr: '' };
    await runPlaudCommand(['files'], { agentId: 'kevin' });
    expect(toasts()).toHaveLength(0);
    expect(config.get('plaud_connected')).toBe('true');
  });
});

// ── THE CARD ─────────────────────────────────────────────────────────────────
// The dashboard package has no test runner; the standing precedent (W4's
// `__tests__/dashboard-dates.test.ts`, `dashboard-date-parse-census.test.ts`)
// puts dashboard-behaviour conformance server-side, reading the source.
describe('the Settings card', () => {
  const card = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/dashboard/src/components/PlaudSettings.tsx'), 'utf-8');
  const apiTypes = fs.readFileSync(
    path.join(REPO_ROOT, 'packages/dashboard/src/lib/api.ts'), 'utf-8');

  it('says plainly that the browser opens on the Mac running the platform', () => {
    // The owner's report: reconnecting opens a browser ON THE SERVER MACHINE,
    // which matters when the dashboard is being viewed from a phone or another
    // computer. The words have to be on the card BEFORE the user clicks.
    expect(card).toMatch(/on the Mac/i);
    expect(card).toMatch(/Dojo|platform|server/i);
  });

  it('renders an EXPIRED state, not just connected/disconnected', () => {
    expect(card).toMatch(/reauthRequired/);
    // and it is a visible state, not a silent branch
    expect(card).toMatch(/Login expired|expired/i);
  });

  it('the wire type carries the new field, so the card is not guessing', () => {
    // The `.26` Health-page lesson (T14): a client that survives on a
    // defensive remap is a type/wire lie held together by guesswork.
    expect(apiTypes).toMatch(/reauthRequired:\s*boolean/);
  });
});
