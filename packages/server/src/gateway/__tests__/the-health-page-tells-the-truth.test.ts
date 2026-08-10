// UX-REPAIR ROUND 2 — T14. THE HEALTH PAGE TELLS THE TRUTH.
//
// Three defects, one class: a card that renders a field the wire does not carry, or carries
// under a name that means something else. Each is pinned here in the direction the plan ruled.
//
//   (a) THE WATCHDOG ALERT.  The watchdog records `lastAlert = { message, at: ISO }`
//       (`watchdog/src/index.ts:447`). The route kept only `.message` and served it under the
//       key `lastAlert`; the client then called a TIMESTAMP formatter on it, so every box with
//       a live alert read a literal "Invalid Date" where the alert should be. The route now
//       serves the alert's own two facts, and the formatter refuses a value it cannot parse.
//
//   (b) THE NAME MISMATCH.  The route emits `lastHeartbeat`; `api.ts` declared `lastCheck`;
//       the page survived on a defensive `wd.lastCheck ?? wd.lastHeartbeat` remap. A type that
//       does not describe the wire is a lie that a remap keeps quiet. The declaration now
//       matches the wire and the remaps are DELETED, not widened.
//
//   (c) THE TWO NEVER-WIRED iMESSAGE ROWS.  MEASURE FIRST was the plan's instruction, and the
//       measurement is the clause `the bridge tracks no last-received/last-sent instant` below:
//       `getIMBridgeStatus()` returns no such field and the module contains no such name, so
//       the two rows could only ever read "Never". They are DELETED — no invented telemetry.
//       If someone later teaches the bridge to track them, that clause goes red and the rows
//       come back with real data behind them. That is the point of pinning a measurement.
//
// The tests run the REAL route through Hono's own request path with a real state file, and the
// REAL client formatter (which this task folded into `lib/dates.ts`, where its two byte-
// identical copies used to sit). Nothing here re-implements what it is checking.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The home the route reads its state file from. Computed inside the factory too (it runs
// before this module's bindings initialize) — same expression, so the two always agree.
const HOME_DIR_NAME = 'dojo-t14-health-truth';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-t14-health-truth');
  return { ...real, homedir, default: { ...real, homedir } };
});

const HOME = path.join(realOs.tmpdir(), HOME_DIR_NAME);
const STATE = path.join(HOME, '.dojo', 'watchdog-state.json');

import { servicesRouter } from '../routes/services.js';
// The client's own formatter, imported — not re-implemented.
import { formatTimestamp, parseUtc } from '../../../../dashboard/src/lib/dates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel: string): string => fs.readFileSync(path.resolve(HERE, rel), 'utf8');
const API_TS = '../../../../dashboard/src/lib/api.ts';
const HEALTH_TSX = '../../../../dashboard/src/pages/Health.tsx';
const PROVIDER_HEALTH_TSX = '../../../../dashboard/src/components/ProviderHealth.tsx';
const SERVICES_TS = '../routes/services.ts';
const BRIDGE_TS = '../../services/imessage-bridge.ts';

const ALERT_TEXT = 'kevin has been working for 47 minutes with no tool call';

function writeState(state: unknown): void {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state));
}

async function watchdogPayload(): Promise<Record<string, unknown>> {
  const res = await servicesRouter.request('/watchdog');
  const body = await res.json() as { ok: boolean; data: Record<string, unknown> };
  expect(body.ok, 'the route answered').toBe(true);
  return body.data;
}

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════
// (a) THE WATCHDOG ALERT — through the real route, then through the real formatter
// ════════════════════════════════════════════════════════════════════════

describe('the watchdog alert reaches the page as an alert AND an instant', () => {
  it('RED→GREEN: an alert on the wire carries both its message and a parseable `at`', async () => {
    const at = new Date(Date.now() - 3 * 60_000).toISOString();
    writeState({ lastHeartbeat: new Date().toISOString(), lastAlert: { message: ALERT_TEXT, at } });

    const data = await watchdogPayload();
    const alert = data.lastAlert as { message: string; at: string } | null;

    expect(alert, 'the alert survives the route').not.toBeNull();
    expect(alert!.message, 'the alert says what happened').toBe(ALERT_TEXT);
    expect(alert!.at, 'the alert says WHEN — the fact the route used to drop').toBe(at);
    expect(Number.isFinite(parseUtc(alert!.at)?.getTime() ?? NaN), '`at` is parseable').toBe(true);
  });

  it('RED→GREEN: the rendered row shows the message and a real time, never "Invalid Date"', async () => {
    const at = new Date(Date.now() - 3 * 60_000).toISOString();
    writeState({ lastHeartbeat: new Date().toISOString(), lastAlert: { message: ALERT_TEXT, at } });

    const alert = (await watchdogPayload()).lastAlert as { message: string; at: string };
    // Exactly what the card renders: the message verbatim, the instant through the formatter.
    const rendered = `${alert.message} · ${formatTimestamp(alert.at)}`;

    expect(rendered).not.toContain('Invalid Date');
    expect(rendered).toContain(ALERT_TEXT);
    expect(rendered).toContain('3m ago');
  });

  it('no alert yet → the field is null and the card says nothing happened', async () => {
    writeState({ lastHeartbeat: new Date().toISOString() });
    const data = await watchdogPayload();
    expect(data.lastAlert).toBeNull();
    expect(formatTimestamp(null)).toBe('Never');
  });

  it('a garbled state file cannot fabricate an alert (the route keeps its tolerate-and-null arm)', async () => {
    writeState({ lastHeartbeat: 42, lastAlert: { message: ALERT_TEXT } });   // no `at`
    const data = await watchdogPayload();
    expect(data.lastHeartbeat, 'a non-string heartbeat is refused').toBeNull();
    expect(data.lastAlert, 'half an alert is no alert — both facts or neither').toBeNull();
    expect(data.running, 'no heartbeat means not running, which is the truthful state').toBe(false);
  });

  it('no state file at all → running:false, both fields null (watchdog never reported in)', async () => {
    const data = await watchdogPayload();
    expect(data).toEqual({ running: false, lastHeartbeat: null, lastAlert: null });
  });
});

// ════════════════════════════════════════════════════════════════════════
// THE FORMATTER — folded out of two byte-identical copies, and given the guard
// every one of its siblings in `lib/dates.ts` already had
// ════════════════════════════════════════════════════════════════════════

describe('formatTimestamp is one function, and it refuses what it cannot parse', () => {
  // The shipped implementation, pinned VERBATIM from Health.tsx:34-46 at fa57740 (byte-identical
  // to the ProviderHealth.tsx:21-33 copy). Both copies are gone; this is what they did, and the
  // clause below proves the survivor still does it for every value that IS a timestamp.
  const ORIGINAL = (ts: string | null): string => {
    if (!ts) return 'Never';
    const d = parseUtc(ts);
    if (!d) return 'Never';
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return d.toLocaleDateString();
  };

  it('byte-identical to the two copies it replaced, across every branch and both wire shapes', () => {
    const ages = [0, 30_000, 59_000, 60_000, 5 * 60_000, 59 * 60_000, 60 * 60_000,
      3 * 3600_000, 23 * 3600_000, 24 * 3600_000, 5 * 86_400_000, 400 * 86_400_000];
    for (const age of ages) {
      const iso = new Date(Date.now() - age).toISOString();                    // ISO-with-Z
      const sqlite = iso.slice(0, 19).replace('T', ' ');                       // Z-less SQLite text
      for (const shape of [iso, sqlite]) {
        expect(formatTimestamp(shape), `age ${age} shape ${shape}`).toBe(ORIGINAL(shape));
      }
    }
    expect(formatTimestamp(null)).toBe(ORIGINAL(null));
    expect(formatTimestamp('')).toBe(ORIGINAL(''));
  });

  it('THE ONE DELIBERATE CHANGE: an unparseable value reads "Never", not "Invalid Date"', () => {
    // The old copies had no NaN guard — alone among the formatters in lib/dates.ts, every one
    // of which checks `isNaN(d.getTime())`. That omission is what turned the mis-served alert
    // message into a rendered "Invalid Date" instead of a quiet "Never". Recorded as a change,
    // not smuggled: ORIGINAL returns 'Invalid Date' here and the survivor does not.
    expect(ORIGINAL(ALERT_TEXT), 'what the shipped copies did').toBe('Invalid Date');
    expect(formatTimestamp(ALERT_TEXT), 'what one guarded formatter does').toBe('Never');
  });

  it('the two local copies are gone — one function, in the module that owns dates', () => {
    for (const rel of [HEALTH_TSX, PROVIDER_HEALTH_TSX]) {
      expect(SRC(rel), `${rel} defines no local formatTimestamp`)
        .not.toMatch(/const formatTimestamp\s*=/);
      expect(SRC(rel), `${rel} imports it from lib/dates`).toMatch(/formatTimestamp/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// (b) + (c) THE TYPES DESCRIBE THE WIRE, AND THE REMAPS ARE GONE
// ════════════════════════════════════════════════════════════════════════

/** The field names an `api.ts` accessor declares in its return type. */
function declaredFields(fnName: string): string[] {
  const src = SRC(API_TS);
  const start = src.indexOf(`export const ${fnName} =`);
  expect(start, `${fnName} exists in api.ts`).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('};', start));
  const shape = /Promise<ApiResponse<\{([\s\S]*?)\}>>/.exec(body)?.[1] ?? '';
  expect(shape, `${fnName} declares an object shape`).not.toBe('');
  return [...shape.matchAll(/^\s{2}([a-zA-Z]\w*)\??:/gm)].map((m) => m[1]);
}

describe('api.ts describes the wire it actually reads', () => {
  it('RED→GREEN: every field getWatchdogStatus declares is one the route emits', async () => {
    writeState({
      lastHeartbeat: new Date().toISOString(),
      lastAlert: { message: ALERT_TEXT, at: new Date().toISOString() },
    });
    const wire = Object.keys(await watchdogPayload());
    expect(declaredFields('getWatchdogStatus').sort()).toEqual(wire.sort());
  });

  it('RED→GREEN: every field getIMBridgeStatus declares is one the bridge emits', async () => {
    const res = await servicesRouter.request('/imessage');
    const body = await res.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    const wire = new Set(Object.keys(body.data));
    for (const f of declaredFields('getIMBridgeStatus')) {
      expect(wire.has(f), `api.ts declares \`${f}\`, and the wire carries it`).toBe(true);
    }
  });

  it('RED→GREEN: Health.tsx reads the wire directly — the defensive remaps are deleted', () => {
    const src = SRC(HEALTH_TSX);
    // The remap was the only thing holding (b) together. Its shape, all four spellings:
    for (const dead of ['wd.lastCheck', 'wd.lastHeartbeat ??', 'im.running ??', 'as Record<string, unknown>']) {
      expect(src, `the remap fragment \`${dead}\` is gone`).not.toContain(dead);
    }
  });
});

describe('the two iMessage rows: the measurement that deleted them, pinned', () => {
  it('the bridge tracks no last-received/last-sent instant — the evidence for the DELETE branch', () => {
    // MEASURE FIRST (plan T14). If this ever goes red, the bridge learned to track them and the
    // two rows should come back — with real data behind them, which is the only way they belong.
    expect(SRC(BRIDGE_TS)).not.toMatch(/lastReceived|lastSent|last_received|last_sent/);
  });

  it('so nothing declares or renders them', () => {
    for (const rel of [API_TS, HEALTH_TSX]) {
      expect(SRC(rel), `${rel}`).not.toMatch(/lastReceived|lastSent/);
    }
    // The rendered rows, not the comment that records why they went.
    expect(SRC(HEALTH_TSX), 'and the rows themselves are gone')
      .not.toMatch(/className="k">Last (received|sent)/);
  });
});

describe('the route keeps the honest fallbacks it already had', () => {
  it('the FA-W5 read-only discipline is intact: the route only READS the state file', () => {
    const src = SRC(SERVICES_TS);
    const watchdogArm = src.slice(src.indexOf("servicesRouter.get('/watchdog'"), src.indexOf("servicesRouter.get('/imessage'"));
    expect(watchdogArm).toContain('readFileSync');
    expect(watchdogArm, 'no write of any kind from the route').not.toMatch(/writeFileSync|prepare\(/);
  });

  it('the 5-minute liveness window is unchanged', () => {
    expect(SRC(SERVICES_TS)).toContain('300000');
  });
});
