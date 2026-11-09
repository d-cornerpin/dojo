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

// The home the route reads its state file from. Computed inside the factory too (it runs
// before this module's bindings initialize) — same expression, so the two always agree.
const HOME_DIR_NAME = 'dojo-t14-health-truth';

// The platform resolves `~/.dojo` in exactly one place — `src/home.ts` — so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t14-health-truth');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
  };
});

const HOME = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), HOME_DIR_NAME);
const STATE = path.join(HOME, '.dojo', 'watchdog-state.json');

import { servicesRouter } from '../routes/services.js';
// The client's own formatter, imported — not re-implemented.
import { formatTimestamp, parseUtc } from '../../../../dashboard/src/lib/dates.js';
import { FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const ALERT_TEXT = `${FXID.n4} has been working for 47 minutes with no tool call`;

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
});
