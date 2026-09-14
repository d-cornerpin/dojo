// ════════════════════════════════════════════════════════════════════════════════
// THE CATEGORY GRANT REACHES THE EXECUTOR (UX-ACCESS A3 rider) — RED-first.
//
// A2 §6.1 recorded the finding and handed it up rather than fixing it:
//
//   > The category grant is SURFACE-ONLY; there is no executor gate for it.
//   > `toolCategoryGranted` has exactly one caller (`surface.ts:634`), and per
//   > Architecture Rule 1 the surface strip is ADVICE. So an agent granted a
//   > CHANNEL but not the tool's CATEGORY passes the permission door if the
//   > model emits the call from free text, while its capability line says it
//   > cannot.
//
// The plan's DESIGN section promises the opposite — *"Enforcement at every
// layer, `can_spawn_agents`-style: model's tool list · EXECUTOR GATE · handler
// walls · channel doors …"* — so the gap is a design-conformance defect, and the
// orchestrator ruled it into A3.
//
// THE FINGERPRINT IS A2'S OWN MEASURED SHAPE (W74 §6.1): an `operator` agent
// holding `channels.master:true` + `imessage:'owner'` and NOT holding the
// `Communication` category. At A2 it reads `no: … messaging people` on its own
// capability line, is stripped of `imessage_send` at the surface — and REACHES
// THE BRIDGE when the call is free-texted, because nothing at the executor asks
// the category question.
//
// RED AT `191bc84c`, measured: `gatesForCall('imessage_send', {})` returns rows
// 7 and 9 only — no row 17, no gate of kind `category` — and `evaluateGate` has
// no `category` arm to answer one with.
//
// MIGRATION-SAFE BY CONSTRUCTION, and that is a measurement, not a hope: every
// agent that exists holds `categories: '*'` (A1's snapshot; 111/111 on the
// owner's box), so this gate refuses NOTHING that is alive today. §4 holds it.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-a3-category', 'dojo.db'),
  };
});

vi.mock('../../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js');
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === 'primary',
    isPMAgent: (id: string) => id === 'pm',
    isHealerAgent: () => false,
    isTrainerAgent: () => false,
    getPrimaryAgentId: () => 'primary',
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { gatesForCall } from '../../tools/gates.js';
import { evaluateGate } from '../../tools/gate-eval.js';
import { forgetAccessGrants, toolCategoryGranted, toolCategoryLabels } from '../read.js';
import { deriveLegacyGrants } from '../derive.js';
import { TOOL_CATEGORIES } from '../../../tools/categories.js';
import { MOST_RESTRICTIVE_GRANTS } from '@dojo/shared';
import type { AccessGrants } from '@dojo/shared';

const db = (): Database.Database => mockDb.current!;

function agent(id: string, classification: string, mutate?: (g: AccessGrants) => void): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, session_started_at)
     VALUES (?, ?, 'idle', ?, '1970-01-01')`,
  ).run(id, id, classification);
  forgetAccessGrants();
  if (!mutate) return;
  const g = deriveLegacyGrants(id);
  mutate(g);
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
}

const ctx = (agentId: string, name: string, args: Record<string, unknown> = {}) => ({
  agentId, name, args, resolveRef: () => null,
});

/** The row-17 gate for this call, or undefined. */
const row17 = (name: string, args: Record<string, unknown> = {}) =>
  gatesForCall(name, args).find((g) => g.row === '17');

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  forgetAccessGrants();
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 · THE GATE IS DECLARED — the requirement is a value, like the other sixteen
// ════════════════════════════════════════════════════════════════════════════════

describe('row 17 — the positive category grant, declared', () => {
  it('⚠ A CATEGORISED TOOL CARRIES A ROW-17 CATEGORY GATE', () => {
    for (const name of ['imessage_send', 'exec', 'web_search', 'gmail_inbox', 'vault_remember']) {
      const g = row17(name);
      expect(g, `${name} carries row 17`).toBeDefined();
      expect(g!.kind).toBe('category');
    }
  });

  it('a tool in NO category carries none — the grant is a layer over the 38 declared groups', () => {
    // `read.ts` states the rule and this holds it at the declaration too: an
    // unlisted name is not an unlisted DENIAL. `user_`-prefixed twins and the
    // Office set are the live examples.
    const uncategorised = ['user_gmail_inbox', 'not_a_real_tool'];
    for (const name of uncategorised) {
      expect(toolCategoryLabels(name), `${name} is genuinely uncategorised`).toEqual([]);
      expect(row17(name), `${name} mints no category gate`).toBeUndefined();
    }
  });

  it('row 17 is LAST, so no existing refusal changes its message', () => {
    // An agent failing row 7 AND row 17 must still read row 7's sentence — the
    // ladder's order is observable and scenarios assert on it.
    const gates = gatesForCall('imessage_send', {});
    expect(gates[gates.length - 1].row).toBe('17');
    expect(gates.some((g) => g.row === '7')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · THE GATE REFUSES — A2's own measured shape, at the executor
// ════════════════════════════════════════════════════════════════════════════════

describe('the free-texted call into an ungranted category is REFUSED', () => {
  beforeEach(() => {
    // W74 §6.1's `operator`, verbatim: holds the CHANNEL, not the CATEGORY.
    agent('operator', 'ronin', (g) => {
      g.channels.master = true;
      g.channels.imessage = 'owner';
      g.tools.categories = ['Meta', 'File & System', 'Managing Other Agents'];
    });
  });

  it('⚠ THE CHANNEL DOOR OPENS AND THE CATEGORY DOOR SHUTS — the A2 hole, closed', async () => {
    // Row 7 passes: the agent genuinely holds the channel. That is what made
    // this reachable at A2 and it is unchanged.
    const channel = gatesForCall('imessage_send', {}).find((g) => g.row === '7')!;
    expect((await evaluateGate(channel, ctx('operator', 'imessage_send'))).verdict.allowed).toBe(true);

    // Row 17 refuses: the tool is in `Communication`, which it was not granted.
    const out = await evaluateGate(row17('imessage_send')!, ctx('operator', 'imessage_send'));
    expect(out.verdict.allowed).toBe(false);
    expect(out.errorCode).toBe('PERMISSION_DENIED');
  });

  it('the refusal is PLAIN, names the group, and says who can grant it', async () => {
    const out = await evaluateGate(row17('imessage_send')!, ctx('operator', 'imessage_send'));
    const message = out.verdict.allowed === false ? out.verdict.blockedMessage : null;
    expect(message).toBeTruthy();
    expect(message!).toContain('imessage_send');
    expect(message!).toContain('Communication');
    expect(message!).toMatch(/not performed/);
    expect(message!).toMatch(/primary agent/);
  });

  it('the refusal carries what an audit row needs: the group it asked about', async () => {
    const out = await evaluateGate(row17('imessage_send')!, ctx('operator', 'imessage_send'));
    // `executeToolInner` writes `auditLog(agentId, auditAs, resource, 'denied', reason)`.
    expect(out.auditAs).toBe('imessage_send');
    expect(out.resource).toBe('Communication');
    expect(out.verdict.allowed === false && out.verdict.reason).toMatch(/Communication/);
  });

  it('⚠ THE POSITIVE CONTROL: grant the group and the same call passes', async () => {
    agent('granted', 'ronin', (g) => {
      g.channels.master = true;
      g.channels.imessage = 'owner';
      g.tools.categories = ['Meta', 'File & System', 'Managing Other Agents', 'Communication'];
    });
    const out = await evaluateGate(row17('imessage_send')!, ctx('granted', 'imessage_send'));
    expect(out.verdict.allowed).toBe(true);
  });

  it('a tool in TWO groups passes on either one — holding any of its groups is holding it', async () => {
    const twoGroups = TOOL_CATEGORIES
      .flatMap((c) => c.tools)
      .find((t, _i, all) => all.filter((x) => x === t).length > 1);
    expect(twoGroups, 'the index still contains a tool filed under two labels').toBeTruthy();
    const labels = toolCategoryLabels(twoGroups!);
    expect(labels.length).toBeGreaterThan(1);
    for (const only of labels) {
      agent(`holds-${labels.indexOf(only)}`, 'ronin', (g) => { g.tools.categories = [only]; });
      const out = await evaluateGate(row17(twoGroups!)!, ctx(`holds-${labels.indexOf(only)}`, twoGroups!));
      expect(out.verdict.allowed, `${twoGroups} under only "${only}"`).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · RULING 2'S DEFAULT NOW BITES AT THE EXECUTOR TOO
// ════════════════════════════════════════════════════════════════════════════════

describe('a most-restrictive sub-agent cannot free-text its way out', () => {
  beforeEach(() => {
    agent('fresh', 'apprentice', (g) => {
      g.tools.categories = [...(MOST_RESTRICTIVE_GRANTS.tools.categories as string[])];
      g.integrations.credentials = [];
      g.integrations.plaud = false;
    });
  });

  it('⚠ web_search, vault_remember and gmail_inbox are REFUSED AT THE EXECUTOR', async () => {
    for (const name of ['web_search', 'vault_remember', 'gmail_inbox']) {
      const out = await evaluateGate(row17(name)!, ctx('fresh', name));
      expect(out.verdict.allowed, `${name} is outside the default's three groups`).toBe(false);
      expect(out.errorCode).toBe('PERMISSION_DENIED');
    }
  });

  it('THE CONTROL: its own lifecycle and its files still work', async () => {
    for (const name of ['complete_task', 'send_to_agent', 'file_read', 'exec', 'load_tool_docs']) {
      const out = await evaluateGate(row17(name)!, ctx('fresh', name));
      expect(out.verdict.allowed, `${name} is inside the default's three groups`).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 · MIGRATION SAFETY, MEASURED — the rider must move no living agent
// ════════════════════════════════════════════════════════════════════════════════

describe('every agent alive today holds `*`, so this gate refuses none of them', () => {
  it('⚠ THE A1 SNAPSHOT GRANTS EVERY CATEGORY — that is why the rider is invisible', () => {
    agent('legacy-primary', 'sensei');
    agent('legacy-ronin', 'ronin');
    agent('legacy-apprentice', 'apprentice');
    for (const id of ['legacy-primary', 'legacy-ronin', 'legacy-apprentice']) {
      expect(deriveLegacyGrants(id).tools.categories, `${id}'s snapshot`).toBe('*');
    }
  });

  it('⚠ AND THE GATE PASSES EVERY TOOL IN THE INDEX FOR SUCH AN AGENT', async () => {
    agent('legacy', 'ronin');
    const everyTool = [...new Set(TOOL_CATEGORIES.flatMap((c) => c.tools))];
    expect(everyTool.length).toBeGreaterThan(100);
    const refused: string[] = [];
    for (const name of everyTool) {
      const gate = row17(name);
      if (!gate) continue;
      const out = await evaluateGate(gate, ctx('legacy', name));
      if (!out.verdict.allowed) refused.push(name);
    }
    expect(refused, 'a `*` agent is refused by row 17 nowhere').toEqual([]);
  });

  it('the reader that answers the gate is the SAME one the surface strip asks', () => {
    // One predicate, two layers — the property that makes "advertised" and
    // "permitted" incapable of drifting apart. If these two ever answer
    // differently the capability line starts lying again.
    agent('narrow', 'ronin', (g) => { g.tools.categories = ['File & System']; });
    expect(toolCategoryGranted('narrow', 'web_search')).toBe(false);
    expect(toolCategoryGranted('narrow', 'exec')).toBe(true);
  });
});
