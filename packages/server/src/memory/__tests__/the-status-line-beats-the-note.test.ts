// ════════════════════════════════════════════════════════════════════════════════════════
// T76b (W85) — THE STATUS LINE BEATS THE NOTE.
//
// ── THE INCIDENT THIS FILE IS DERIVED FROM (W84, 2026-09-16) ────────────────────────────
// A regex in `plaud/tools-read.ts` matched zero of the 23 rows the Plaud CLI printed, so
// three read tools answered `No recordings found.` over a full account. The regex is fixed
// (T75b, `a10745e6`). What is NOT fixed by that commit is the second half of the incident,
// recorded in W84 §5: while diagnosing it the agent concluded that Plaud "flaps" and WROTE
// THAT INTO ITS VAULT. The entry was deleted by hand — one row, not the mechanism.
//
// A false memory about a connection is self-sealing. It returns through
// `msg.relevant-memory`, the agent declines to call the tool on the strength of it, and
// reports a remembered breakage as current fact. Nothing in the assembled context outranked
// it, because nothing in the assembled context SAID ANYTHING about whether the connection
// worked.
//
// ── THE PROPERTY, STATED ONCE ───────────────────────────────────────────────────────────
// The platform's own record of each GRANTED integration is published in the volatile tail on
// every turn, it says out loud that it supersedes remembered claims, and EVERY TERM IN IT IS
// READ FROM A LEDGER. A status line that invents a freshness is the W84 defect one surface
// over: a confident sentence with nothing behind it.
//
// The clauses below are the two halves of that sentence — what the block is allowed to say
// (§1, §2), who it is allowed to say it about (§3), and the two properties that let it ride
// the tail at all (§4 byte-stability, §5 the declared reserve and the declared position).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

// ── The three doors `buildIntegrationStatusLane` asks, stubbed at the module boundary ──
// They are stubbed rather than seeded because their real implementations read OAuth token
// rows, a `config` table and an `agents.permissions` JSON document — three storage shapes
// that have nothing to do with the property under test, and seeding them would make this file
// a test of `google/auth.ts`. What must NOT be stubbed is the LEDGER half: `google_activity`,
// `microsoft_activity` and `agent_tool_failures` are real rows in a real migrated database
// below, because "the term comes from a ledger" is the whole claim.
const world = {
  statuses: [] as Array<{ name: 'google' | 'microsoft' | 'plaud'; configured: boolean; connected: boolean }>,
  plaudGranted: true,
  levels: { google: 'full', microsoft: 'full' } as Record<string, string>,
  plaudConnectedAt: '2026-09-14T06:22:14.954Z' as string | null,
};

vi.mock('../../services/capability-registry.js', () => ({
  listIntegrationStatuses: () => world.statuses,
}));
vi.mock('../../agent/access/read.js', () => ({
  mayUsePlaud: () => world.plaudGranted,
  widestIntegrationLevel: (_a: string, p: 'google' | 'microsoft') => world.levels[p],
}));
vi.mock('../../plaud/auth.js', () => ({
  getPlaudStatus: () => ({
    connected: true, reauthRequired: false, email: 'owner@example.com',
    connectedAt: world.plaudConnectedAt, loginInProgress: false, loginUrl: null,
  }),
}));

import { runMigrations } from '../../db/migrations.js';
import {
  buildIntegrationStatusLane,
  renderIntegrationStatusBlock,
  integrationStatusWorstCaseTokens,
  forgetToolFamilyIndex,
  integrationFamilyForLabel,
  INTEGRATION_STATUS_LANE_ID,
  INTEGRATION_STATUS_ENTRY_ID,
  INTEGRATION_STATUS_HEAD,
  INTEGRATION_STATUS_SUPERSEDES,
  INTEGRATION_STATUS_NO_LEDGER_NOTE,
  type IntegrationStatusRow,
} from '../integration-status-lane.js';
import { TOOL_CATEGORIES } from '../../tools/categories.js';
import { MessageSlot } from '../../prompt/registry/types.js';
import { POST_BUDGET_LANES, POST_BUDGET_ENTRY_LANE, LANE_LIMITS, laneLimit } from '../lanes.js';
import { estimateTokens } from '../budget.js';
import { engineFileWithBoth } from '../../agent/v2/__tests__/engine-sources.js';

const AGENT = 'agent-t76b';

/** `google_activity.created_at` / `microsoft_activity.created_at` are TEXT in SQLite's own
 *  `datetime('now')` shape, which is what the writers produce. */
const sqliteStamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function seedActivity(
  table: 'google_activity' | 'microsoft_activity',
  atMs: number,
  success: 0 | 1,
  agentId = AGENT,
): void {
  const col = table === 'google_activity' ? 'gws_command' : 'api_endpoint';
  mockDb.current!.prepare(
    `INSERT INTO ${table} (id, agent_id, agent_name, action, action_type, details, ${col},
                           success, error, created_at)
     VALUES (?, ?, 'T76b', 'probe', 'read', NULL, NULL, ?, NULL, ?)`,
  ).run(`act-${table}-${atMs}-${success}-${agentId}`, agentId, success, sqliteStamp(atMs));
}

function seedFailure(tool: string, atMs: number, hits: number): void {
  mockDb.current!.prepare(
    `INSERT INTO agent_tool_failures (agent_id, signature, tool_name, hit_count, first_at, last_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(AGENT, `${tool}|sig`, tool, hits, sqliteStamp(atMs), sqliteStamp(atMs));
}

const ALL_THREE_CONNECTED = [
  { name: 'google' as const, configured: true, connected: true },
  { name: 'microsoft' as const, configured: true, connected: true },
  { name: 'plaud' as const, configured: true, connected: true },
];

const DAY_ONE = Date.parse('2026-09-16T10:00:00Z');
const HOUR = 3_600_000;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare(
    "INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'T76b', 'idle', NULL, '{}')",
  ).run(AGENT);
  world.statuses = ALL_THREE_CONNECTED.map((s) => ({ ...s }));
  world.plaudGranted = true;
  world.levels = { google: 'full', microsoft: 'full' };
  world.plaudConnectedAt = '2026-09-14T06:22:14.954Z';
  forgetToolFamilyIndex();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  vi.useRealTimers();
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — EVERY TERM COMES FROM A LEDGER, AND A MISSING LEDGER IS SAID OUT LOUD
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T76b §1 — the line carries only what a ledger records', () => {
  it('a successful activity row becomes the RECORDED INSTANT of the last use', async () => {
    seedActivity('google_activity', DAY_ONE - 3 * HOUR, 1);
    seedActivity('google_activity', DAY_ONE - HOUR, 1);
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).toBeTruthy();
    // The newest SUCCESS, rendered in the one stamp format the fresh tail already uses.
    const expected = new Date(sqliteStamp(DAY_ONE - HOUR) + 'Z');
    const hh = expected.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
    expect(block).toContain(`Google Workspace — CONNECTED. Last successful use [${hh}].`);
  });

  it('a FAILED activity row is never read as a successful use', async () => {
    seedActivity('google_activity', DAY_ONE - 3 * HOUR, 1);
    seedActivity('google_activity', DAY_ONE - HOUR, 0);   // newer, but success = 0
    const block = await buildIntegrationStatusLane(AGENT);
    const older = new Date(sqliteStamp(DAY_ONE - 3 * HOUR) + 'Z').toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
    expect(block).toContain(`Last successful use [${older}].`);
  });

  it("ANOTHER agent's successful call is not reported as this agent's", async () => {
    // Not a scoping nicety: 16,432 of the dev body's 16,820 google rows are `agent_id='system'`
    // inbox polls firing on a timer. An unscoped MAX would tick every 30 seconds and churn the
    // tail with nothing this agent did having changed.
    seedActivity('google_activity', DAY_ONE, 1, 'system');
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).not.toContain('Last successful use');
  });

  it('PLAUD HAS NO SUCCESS LEDGER, so it states none — and the block says why', async () => {
    // The census that bounds this block: no plaud row exists in `tool_receipts` (send-class
    // only), none in `audit_log`, and there is no `plaud_activity` table. The honest line is
    // the connect instant plus the failure ledger, and an UNEXPLAINED blank is the W84 defect
    // one surface over — a confident absence.
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).toContain('• Plaud — CONNECTED since [');
    expect(block).not.toMatch(/• Plaud[^\n]*Last successful use/);
    expect(block).toContain(INTEGRATION_STATUS_NO_LEDGER_NOTE);
    expect(INTEGRATION_STATUS_NO_LEDGER_NOTE).toContain('absence of RECORDS, not a record of failure');
  });

  it('an unresolved failure prints its tool, its instant and its count', async () => {
    seedFailure('outlook_search', DAY_ONE - 2 * HOUR, 4);
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).toMatch(/• Microsoft 365[^\n]*UNRESOLVED FAILURE: outlook_search, last failed \[[^\]]+\] after 4 attempts, with no success since\./);
  });

  it('NO failure row is itself a printed fact — a success DELETES the row, so silence means clear', async () => {
    // `agent/v2/attempt-record.ts:35` deletes on success. That deletion is what makes the
    // sentence worth printing, and it is the one outcome fact available for a family with no
    // success ledger at all — which is exactly the family the incident was about.
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).toContain('• Plaud — CONNECTED since');
    expect(block).toMatch(/• Plaud[^\n]*No unresolved tool failure on record\./);
  });

  it('EVERY category label is classified — a new one fails HERE, it does not vanish', () => {
    // The census that makes the label map safe. A tool added to an existing category is
    // picked up with no edit at all; a NEW category added to `tools/categories.ts` with no
    // row in `LABEL_FAMILY` is the one way this block could silently stop seeing a family's
    // failures, and this clause is what refuses that day.
    const unclassified = TOOL_CATEGORIES
      .map((c) => c.label)
      .filter((label) => integrationFamilyForLabel(label) === undefined);
    expect(unclassified, `unclassified in memory/integration-status-lane.ts LABEL_FAMILY: ${unclassified.join(' | ')}`)
      .toEqual([]);
  });

  it('the failure is attributed to the family the CATEGORY TABLE names, not a typed prefix', async () => {
    seedFailure('plaud_recent_recordings', DAY_ONE - HOUR, 2);
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).toMatch(/• Plaud[^\n]*UNRESOLVED FAILURE: plaud_recent_recordings/);
    // And a LOCAL Office tool is not evidence about the Graph connection: those tools run on
    // this machine with no Microsoft account (the carve-out `renderIntegrationReconnect`
    // already declares), so a failure in one says nothing about Microsoft 365.
    seedFailure('office_create_word_document', DAY_ONE, 9);
    forgetToolFamilyIndex();
    const after = await buildIntegrationStatusLane(AGENT);
    expect(after).not.toContain('office_create_word_document');
  });

  it('CONTROL — nothing in the block is a relative time read off the wall clock', async () => {
    seedActivity('google_activity', DAY_ONE - HOUR, 1);
    seedFailure('outlook_search', DAY_ONE - 2 * HOUR, 4);
    const block = await buildIntegrationStatusLane(AGENT) ?? '';
    expect(block).not.toMatch(/\b\d+\s+(second|minute|hour|day|week|month)s?\s+ago\b/);
    expect(block).not.toMatch(/\bjust now\b|\bmoments ago\b/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE SUPERSESSION PREAMBLE: THE BLOCK SAYS WHAT IT OUTRANKS
//
// HL5's `SNAPSHOT_SUPERSEDES` had to NAME the surfaces it outranks, because naming them is
// what stops the model reading the published set as one more opinion. This one names the
// same three and adds the surface W84 actually died on: a note the agent saved itself.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T76b §2 — the preamble outranks memory, by name', () => {
  it('names summaries, recalled memory, the agent\'s own saved notes, and this conversation', () => {
    for (const surface of ['summaries', 'recalled memory', 'notes you saved yourself', 'earlier in this conversation']) {
      expect(INTEGRATION_STATUS_SUPERSEDES, `the preamble does not name: ${surface}`).toContain(surface);
    }
  });

  it('classifies the remembered claim as a MEMORY and the block as the current record', () => {
    expect(INTEGRATION_STATUS_SUPERSEDES).toContain('is a MEMORY of one past call');
    expect(INTEGRATION_STATUS_SUPERSEDES).toContain("read from the platform's own records on this turn");
  });

  it('resolves the disagreement EXPLICITLY, and toward the tool rather than toward silence', async () => {
    // "believe this block" alone would leave the model free to answer from the block. The
    // instruction that closes W84 is the one that sends it to the door.
    expect(INTEGRATION_STATUS_SUPERSEDES).toContain('Where the two disagree, this block is right');
    expect(INTEGRATION_STATUS_SUPERSEDES).toContain('call the tool and answer from what it returns');
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).toContain(INTEGRATION_STATUS_HEAD);
    expect(block).toContain(INTEGRATION_STATUS_SUPERSEDES);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — ONLY WHAT THIS AGENT MAY ACTUALLY TOUCH, AND NO FALSE REASSURANCE
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T76b §3 — the line is grant-scoped, and a down connection reads down', () => {
  it('an UNGRANTED Plaud is absent from the line entirely', async () => {
    world.plaudGranted = false;
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).not.toContain('Plaud');
    expect(block).toContain('Google Workspace');   // the others are untouched
  });

  it('an UNGRANTED Workspace provider is absent from the line entirely', async () => {
    world.levels.microsoft = 'none';
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).not.toContain('Microsoft 365');
    expect(block).toContain('Google Workspace');
  });

  it('a family the owner never configured is absent — there is no truth to publish', async () => {
    world.statuses = world.statuses.filter((s) => s.name !== 'plaud')
      .concat([{ name: 'plaud', configured: false, connected: false }]);
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).not.toContain('Plaud');
  });

  it('NEGATIVE CONTROL — a granted, configured, DISCONNECTED integration reads disconnected', async () => {
    // The failure this clause refuses is the mirror of W84: a block that reassures the model a
    // connection is live when it is not would send it to a door that has been removed from its
    // toolset, and the confident wrong answer would come back the other way round.
    world.statuses = [
      { name: 'google', configured: true, connected: true },
      { name: 'microsoft', configured: true, connected: false },
      { name: 'plaud', configured: true, connected: true },
    ];
    const block = await buildIntegrationStatusLane(AGENT);
    expect(block).toContain('• Microsoft 365 — DISCONNECTED. Its tools are not in your toolset this turn.');
    expect(block).not.toMatch(/• Microsoft 365 — CONNECTED/);
  });

  it('an agent granted nothing at all renders NO BLOCK, rather than an empty frame', async () => {
    world.plaudGranted = false;
    world.levels = { google: 'none', microsoft: 'none' };
    expect(await buildIntegrationStatusLane(AGENT)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE BLOCK HOLDS STILL (T69b's tail property, extended to cover this lane)
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T76b §4 — byte-identical until the LEDGER moves', () => {
  it('is byte-identical 90 minutes later with no ledger row touched', async () => {
    seedActivity('google_activity', DAY_ONE - HOUR, 1);
    seedFailure('outlook_search', DAY_ONE - 2 * HOUR, 4);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY_ONE));
    const before = await buildIntegrationStatusLane(AGENT);
    vi.setSystemTime(new Date(DAY_ONE + 90 * 60_000));
    const after = await buildIntegrationStatusLane(AGENT);
    expect(after).toBe(before);
    expect(before).toBeTruthy();
  });

  it('CONTROL — a new SUCCESS row does move it, and that is a real content change', async () => {
    seedActivity('google_activity', DAY_ONE - HOUR, 1);
    const before = await buildIntegrationStatusLane(AGENT);
    seedActivity('google_activity', DAY_ONE, 1);
    const after = await buildIntegrationStatusLane(AGENT);
    expect(after).not.toBe(before);
  });

  it('CONTROL — a connection flipping down moves it', async () => {
    const before = await buildIntegrationStatusLane(AGENT);
    world.statuses = world.statuses.map((s) => (s.name === 'plaud' ? { ...s, connected: false } : s));
    expect(await buildIntegrationStatusLane(AGENT)).not.toBe(before);
  });

  it('the row ORDER is the family name, not the registry\'s iteration order', async () => {
    const forward = await buildIntegrationStatusLane(AGENT) ?? '';
    world.statuses = [...world.statuses].reverse();
    const reversed = await buildIntegrationStatusLane(AGENT) ?? '';
    expect(reversed).toBe(forward);
    expect(forward.indexOf('Google Workspace')).toBeLessThan(forward.indexOf('Microsoft 365'));
    expect(forward.indexOf('Microsoft 365')).toBeLessThan(forward.indexOf('Plaud'));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE DECLARED RESERVE AND THE DECLARED POSITION
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T76b §5 — the lane declares a derived reserve and a defended position', () => {
  const lane = () => {
    const l = POST_BUDGET_LANES.find((x) => x.id === INTEGRATION_STATUS_LANE_ID);
    expect(l, `${INTEGRATION_STATUS_LANE_ID} is not declared in POST_BUDGET_LANES`).toBeTruthy();
    return l!;
  };

  it('the reserve LITERAL is the value the real renderer produces', () => {
    expect(lane().reserveTokens).toBe(integrationStatusWorstCaseTokens());
  });

  it('no input can exceed the reserve — the render fits itself before it leaves the module', async () => {
    seedFailure('a'.repeat(400), DAY_ONE, 999_999);
    const block = await buildIntegrationStatusLane(AGENT) ?? '';
    expect(estimateTokens(block)).toBeLessThanOrEqual(lane().reserveTokens);
  });

  it('the row cap is a CEILING ON THE FAMILY UNION, never a truncation of granted lines', async () => {
    // `listIntegrationStatuses()` returns one entry per member of its own three-member union.
    // If a fourth family ships, this clause is what notices before a granted line disappears.
    const families = new Set(ALL_THREE_CONNECTED.map((s) => s.name));
    expect(laneLimit(INTEGRATION_STATUS_LANE_ID, 'rows', 'integrations'))
      .toBeGreaterThanOrEqual(families.size);
    const block = await buildIntegrationStatusLane(AGENT) ?? '';
    expect(block.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(families.size);
  });

  it('it rides the TAIL: past the fresh tail, behind peer-status, ahead of the recall lane', () => {
    expect(lane().slot).toBe(MessageSlot.IntegrationStatusTail);
    expect(MessageSlot.IntegrationStatusTail).toBeGreaterThan(MessageSlot.FreshTail);
    expect(MessageSlot.PeerStatus).toBeLessThan(MessageSlot.IntegrationStatusTail);
    expect(MessageSlot.IntegrationStatusTail).toBeLessThan(MessageSlot.RecalledMemory);
  });

  it('the entry is DECLARED against its own lane, so the receipt prices it separately', () => {
    expect(POST_BUDGET_ENTRY_LANE[INTEGRATION_STATUS_ENTRY_ID]).toBe(INTEGRATION_STATUS_LANE_ID);
    expect(LANE_LIMITS[INTEGRATION_STATUS_LANE_ID]).toBeTruthy();
    expect(lane().measured.length).toBeGreaterThan(20);
  });

  /**
   * The injection ORDER, read from the ENGINE FILE that decides it through the shared
   * derivation (`engine-sources.ts`) — never by a hand-typed path. T69b §4's rule: a guard
   * that names `agent/v2/steps/...` by path stops seeing its subject SILENTLY the next time a
   * tranche moves it.
   */
  const injectionOrder = (): string[] => {
    const src = engineFileWithBoth("'engine.open-commitments'", "'msg.current-time'");
    const ids: string[] = [];
    for (const m of src.text.matchAll(
      /(?:injectRegistryMessage|pushEngineMessage)\([^)]*?['"]((?:msg|engine)\.[a-z-]+)['"]/gs,
    )) {
      if (!ids.includes(m[1])) ids.push(m[1]);
    }
    return ids;
  };

  it('it is injected AFTER every stable block and BEFORE the deliberate-churn group', () => {
    const order = injectionOrder();
    const at = (id: string) => {
      const i = order.indexOf(id);
      expect(i, `${id} is not injected by pre-call-injections.ts`).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Behind everything that changes rarely...
    expect(at('engine.open-commitments')).toBeLessThan(at('msg.integration-status'));
    expect(at('msg.peer-status')).toBeLessThan(at('msg.integration-status'));
    // ...and in front of the four registered as deliberately per-turn, so the bytes it
    // re-bills when a successful call moves it were being re-billed anyway.
    expect(at('msg.integration-status')).toBeLessThan(at('engine.recently-answered'));
    expect(at('msg.integration-status')).toBeLessThan(at('msg.relevant-memory'));
    expect(at('msg.integration-status')).toBeLessThan(at('msg.current-time'));
  });

  it('the block renders as ONE message, framed, with no truncation marker on a normal body', async () => {
    const block = await buildIntegrationStatusLane(AGENT) ?? '';
    expect(block.startsWith(INTEGRATION_STATUS_HEAD)).toBe(true);
    expect(block.trimEnd().endsWith('═══ END INTEGRATION STATUS ═══')).toBe(true);
  });

  it('the pure renderer is callable with no database — the worst-case generator depends on it', () => {
    const rows: IntegrationStatusRow[] = [{
      family: 'plaud', displayName: 'Plaud', connected: true,
      lastSuccessAt: null, connectedSince: '2026-09-14T06:22:14.954Z',
      unresolved: null, hasSuccessLedger: false,
    }];
    expect(renderIntegrationStatusBlock(rows)).toContain('• Plaud — CONNECTED since [');
    expect(renderIntegrationStatusBlock([])).toBeNull();
  });
});
