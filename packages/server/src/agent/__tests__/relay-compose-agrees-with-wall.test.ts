// ════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 item 5, BATCH B — THE COMPOSE PATH AND THE CHANNEL WALL AGREE.
//
// SWEEP-A's INBOUND, routed 2026-08-04 from PHASE-6 T0-KIT (evidence
// `.superpowers/sdd/PHASE-6/task-T0K-report.md`, cited not restated):
//
//   > the A2A join-relay composes owner-channel replies on ANY agent while the channel
//   > handlers refuse a non-primary one — and the refusal is SILENT (a dashboard fallback
//   > plus a warn line; the relay never learns).
//
// Requirement: **the compose path and the wall AGREE** — either composition is scoped to the
// agents the handlers will serve, or the refusal surfaces LOUDLY to the relay so the failure
// is visible and steerable. **REFUSAL: never closed by widening the wall** — a non-primary
// agent gaining owner-channel send is a capability the owner has not granted.
//
// ── WHAT WAS TRUE AT `a38f0a8`, RE-DERIVED HERE ──
// `deliverJoinResultToOwnerInner` has four channel branches. Three call `executeTool` and
// each of those tools sits behind a primary-only wall INSIDE its own handler:
//     teams_send_message  -> provider/microsoft.ts `outlook_send`  (isPrimaryAgent)
//     gmail_reply         -> provider/google.ts    `gmail_send`    (isPrimaryAgent)
//     outlook_reply       -> provider/microsoft.ts `outlook_send`  (isPrimaryAgent)
//     sms_send            -> cat/comms.ts          `sms_send`      (isPrimaryAgent)
// The fourth calls `sendResponseViaIMessage` directly, so it crosses NO wall at all while
// the `imessage_send` TOOL is refused to a non-primary agent by gate ladder row 7.
// The relay read only `r.kind === 'applied'`, so a permission refusal and "this channel does
// not apply" were the same fact to it, and both produced the same silent dashboard fallback.
//
// ── THE TWO HALVES THIS FILE PINS ──
//   1. SCOPE. The relay asks the wall's OWN predicate (`isPrimaryAgent`) before composing.
//      Not a copy of the rule — the same function the four handlers call.
//   2. LOUD. When the scope check refuses, or when a handler refuses anyway, the relay
//      LEARNS: an error-level log naming the agent, the channel and the tool, and an
//      owner-alert row announced through the ONE door (SWEEP-A TB4's shape, policed by
//      `owner-alert-announce-census.test.ts`). The answer itself is never lost — the
//      dashboard fallback still carries it, per the 2026-08-05 governing priority.
//
// THE WALL IS NOT WIDENED, and §3 proves it by DRIVING all four handlers with a non-primary
// agent and asserting each still refuses.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-relay-wall-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { ownerChannelRelayRefusal } from '../a2a-transport.js';
import { handlerFor } from '../tools/handlers.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const PRIMARY = FXID.n4;
const OTHER = 'harnessbot';

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  for (const [k, v] of [['primary_agent_id', PRIMARY], ['primary_agent_name', FX.n4]]) {
    db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(k, v);
  }
  for (const id of [PRIMARY, OTHER]) {
    db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')`).run(id, id);
  }
  clearPlatformConfigCache();
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · THE WALL IS NOT WIDENED — the four handlers still refuse a non-primary agent
// ════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════
// 3 · THE AGREEMENT, DRIVEN — both sides asked, on the same agents, per channel
// ════════════════════════════════════════════════════════════════════════════════
//
// The clauses above read source. These RUN both halves: the compose path's own predicate and
// the handler the relay would actually call, on the same two agents, and require them to
// return the SAME verdict. That is what "AGREE" means, and it is the arm that bites when the
// wall moves in either direction — widened OR narrowed — which a source grep for the guard's
// text cannot do.

/** The three doors the relay reaches through `executeTool`, with the dispatch key each of the
 *  relay's tool names resolves to. The iMessage branch is §3b's, because it crosses a gate
 *  ladder row rather than a handler. */
const RELAY_TOOL_DOORS: ReadonlyArray<{ channel: string; tool: string }> = [
  { channel: 'teams', tool: 'teams_send_message' },
  { channel: 'email', tool: 'gmail_reply' },
  { channel: 'email', tool: 'outlook_reply' },
  { channel: 'sms', tool: 'sms_send' },
];

/** Ask the REAL handler, with a non-primary agent. Every one of these walls returns before it
 *  touches a network, which is the guard's whole purpose, so this is deterministic and offline. */
const handlerRefuses = async (tool: string, agentId: string): Promise<boolean> => {
  const h = handlerFor(tool);
  expect(h, `${tool} resolves to a handler`).toBeDefined();
  const out = await h!({ agentId, name: tool, args: {}, callId: 'c1', toolCall: { id: 'c1', name: tool, arguments: {} } });
  return out.isError === true && /permission denied/i.test(out.content);
};

describe('REFUSAL: never closed by widening the wall — the two halves agree, driven', () => {
  it('a NON-PRIMARY agent: the compose path refuses, and so does every handler', async () => {
    for (const { channel, tool } of RELAY_TOOL_DOORS) {
      const composeSaysNo = ownerChannelRelayRefusal(OTHER, channel, tool) !== null;
      const wallSaysNo = await handlerRefuses(tool, OTHER);
      expect(composeSaysNo, `compose path refuses ${tool}`).toBe(true);
      expect(wallSaysNo, `the ${tool} handler refuses a non-primary agent`).toBe(true);
      expect(composeSaysNo, `compose and wall agree on ${tool}`).toBe(wallSaysNo);
    }
  });

  it('the PRIMARY agent: the compose path admits it, and so does every handler', async () => {
    for (const { channel, tool } of RELAY_TOOL_DOORS) {
      const composeSaysNo = ownerChannelRelayRefusal(PRIMARY, channel, tool) !== null;
      const wallSaysNo = await handlerRefuses(tool, PRIMARY);
      expect(composeSaysNo, `compose path admits ${tool}`).toBe(false);
      expect(wallSaysNo, `the ${tool} handler admits the primary agent`).toBe(false);
    }
  });

  it('the refusal NAMES the channel and the door, so the owner can be told which one', () => {
    const r = ownerChannelRelayRefusal(OTHER, 'imessage', 'imessage-bridge');
    expect(r).not.toBeNull();
    expect(r!.channel).toBe('imessage');
    expect(r!.tool).toBe('imessage-bridge');
    expect(r!.why).toMatch(/only the primary agent/i);
  });
});
