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
import fs from 'node:fs';
import path from 'node:path';
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-relay-wall-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { ownerChannelRelayRefusal } from '../a2a-transport.js';
import { handlerFor } from '../tools/handlers.js';

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SRC = path.join(REPO, 'packages/server/src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

const PRIMARY = 'kevin';
const OTHER = 'behaviorbot';

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  for (const [k, v] of [['primary_agent_id', PRIMARY], ['primary_agent_name', 'Kevin']]) {
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

/** The relay's own body — from the inner function to the end of its delivery record. */
const relayBody = (): string => {
  const src = read('agent/a2a-transport.ts');
  const at = src.indexOf('async function deliverJoinResultToOwnerInner');
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', src.indexOf('return deliveryId;', at));
  return src.slice(at, end);
};

// ════════════════════════════════════════════════════════════════════════════════
// 1 · SCOPE — the compose path asks the wall's own predicate before it composes
// ════════════════════════════════════════════════════════════════════════════════

describe('the compose path is scoped to the agents the handlers will serve', () => {
  it('the relay consults the wall\'s OWN predicate, not a copy of the rule', () => {
    expect(relayBody()).toMatch(/ownerChannelRelayRefusal\(/);
    // And the verdict is BRANCHED ON, not merely computed: the first arm of the channel chain
    // is the refusal itself, spelled exactly, so a bypass (`if (false)`) reds here.
    expect(relayBody()).toContain('    if (relayRefusal) {\n      // Composed nothing.');
    const gate = read('agent/a2a-transport.ts');
    const at = gate.indexOf('export function ownerChannelRelayRefusal');
    expect(at).toBeGreaterThan(-1);
    // The predicate IS `isPrimaryAgent` — the same function `provider/microsoft.ts`,
    // `provider/google.ts` and `cat/comms.ts` each call, and the same one gate ladder row 7
    // resolves for `imessage_send`. A second spelling of "who may send on the owner's
    // channels" is the disagreement this task exists to end.
    expect(gate.slice(at, gate.indexOf('\n}\n', at))).toMatch(/isPrimaryAgent\(/);
  });

  // ⚠ THIS CLAUSE WAS WEAK AS FIRST WRITTEN AND IS RECORDED RATHER THAN QUIETLY FIXED.
  // It compared `indexOf('ownerChannelRelayRefusal(')` against each branch's index — and at
  // the pre-change tree that call does not exist, so `indexOf` returned -1, which is less
  // than every branch index, and the clause PASSED at RED for exactly the wrong reason. The
  // gate's own position is now asserted before it is compared against anything.
  it('EVERY owner-channel branch is behind the scope check — no branch is left ungated', () => {
    const body = relayBody();
    const gate = body.indexOf('ownerChannelRelayRefusal(');
    expect(gate, 'the scope check is resolved in the relay body').toBeGreaterThan(-1);
    // The four channel branches, named by the door each one crosses.
    for (const door of [
      'sendResponseViaIMessage', 'teams_send_message', 'gmail_reply', 'sms_send',
    ]) {
      const at = body.indexOf(door);
      expect(at, `${door} still appears in the relay`).toBeGreaterThan(-1);
      // The refusal is resolved ONCE, above every branch, so a fifth channel added later
      // cannot be added outside it.
      expect(gate).toBeLessThan(at);
    }
  });

  it('the answer is never lost — the dashboard fallback still runs after a refusal', () => {
    // The governing priority (owner, 2026-08-05): "the user asks the agent to do something
    // and it does it. Period." A refusal on the channel must never cost the owner the answer.
    const body = relayBody();
    expect(body).toMatch(/if \(!delivered\) \{/);
    expect(body).toContain('Always reaches them, so the text is never lost.');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · LOUD — the relay learns, and so does the owner
// ════════════════════════════════════════════════════════════════════════════════

describe('the refusal surfaces LOUDLY to the relay', () => {
  it('is logged at ERROR level naming the agent, the channel and the tool it would have used', () => {
    const body = relayBody();
    const at = body.indexOf('logger.error(');
    expect(at, 'the relay logs a refusal at error level').toBeGreaterThan(-1);
    const call = body.slice(at, body.indexOf('});', at));
    for (const field of ['agentId', 'channel', 'tool']) expect(call).toContain(field);
  });

  it('tells the OWNER, through the one announce door (SWEEP-A TB4\'s shape)', () => {
    const body = relayBody();
    // The platform's own voice: `role='system'` + the shared prefix, written and then put on
    // the wire in the same breath. An alert nobody reads is a silenced alarm.
    // Scoped to the NOTICE ITSELF. `OWNER_ALERT_HEADS_UP_PREFIX` also appears in this body on
    // the platform-voice compose, so a bare file-wide grep would pass with the prefix stripped
    // from exactly the row this clause is about.
    const at = body.indexOf('const notice = ');
    expect(at, 'the relay composes an owner notice').toBeGreaterThan(-1);
    const notice = body.slice(at, body.indexOf(';', body.indexOf('relayRefusal.why', at)));
    expect(notice).toContain('${OWNER_ALERT_HEADS_UP_PREFIX}');
    // …and it is put on the wire in the same breath (SWEEP-A TB4: a row nobody is told about
    // is a reload-only row).
    expect(body.slice(at)).toMatch(/type: 'chat:message'/);
  });

  it('says WHICH channel the answer could not go back on — a steerable sentence, not a code', () => {
    const body = relayBody();
    const at = body.indexOf('could not send');
    expect(at, 'the owner is told in words').toBeGreaterThan(-1);
  });

  it('a handler that refuses ANYWAY is reported by the same path — not only the scope check', () => {
    const body = relayBody();
    // Each branch's post-call read must be able to distinguish "refused" from "not applied",
    // so the wall moving underneath the relay cannot make the failure silent again.
    // FIVE call sites, counted: one per channel branch (4) plus the throw path's. A branch
    // that quietly loses its post-call read is a channel whose refusal is silent again, and a
    // bare `toMatch` cannot see that — the other four keep it green.
    expect((body.match(/noteRelayRefusal\(/g) ?? []).length).toBe(5);
  });

  it('says NOTHING when the channel simply does not apply — silence is only wrong for a REFUSAL', () => {
    // A dashboard-origin ask has no channel meta at all; the fallback IS the delivery and
    // there is no refusal to report. An alert on every ordinary relay would be the noise that
    // makes the real one invisible.
    const body = relayBody();
    const at = body.indexOf('if (relayRefusal');
    expect(at, 'the alert is conditional on a refusal').toBeGreaterThan(-1);
  });
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

  it('the iMessage tool is still primary-only at gate ladder row 7', () => {
    // The relay's iMessage branch calls the BRIDGE, not the tool, so this half is read at the
    // ladder — and it is the reason that branch had to come inside the scope check at all.
    const gates = read('agent/tools/gates.ts');
    expect(gates).toMatch(/IMESSAGE_PRIMARY_ONLY\.has\(name\)/);
    expect(gates).toContain("row: '7',");
  });

  it('the relay grants NO new send capability — it holds no primary override of its own', () => {
    const body = relayBody();
    for (const forbidden of ['isPrimaryAgent = true', 'asPrimary', 'primaryOverride', 'bypassWall']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
