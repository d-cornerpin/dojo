// ════════════════════════════════════════════════════════════════════════════════
// THE ACCESS PANEL (UX-ACCESS A3) — the owner's half of the grants, RED-first.
//
// A1 built the object and the walls. A2 built the door a MODEL grants through.
// Neither built the door the OWNER grants through, and until it exists the whole
// phase is invisible to the person it is for: `effectiveGrants` has been on
// `GET /agents/:id` since A2 and nothing reads it; the validated `grants` body on
// `PUT /agents/:id` has no caller.
//
// This file holds the three server-side halves the panel stands on:
//
//   1. THE PRESETS. Four, from the plan: "Most restrictive" (ruling 2's default),
//      "Reader", "Operator", "Full trust". They are SERVER truth, built from the
//      real category index, so a preset can never name a group the platform does
//      not have — and they are HONEST, which here has a precise meaning: a preset
//      never grants a channel without the tool group that channel's send tool
//      lives in (A2 §6.2's hand-up: "a channel granted without its tool category
//      is inert").
//   2. THE CATALOG ROUTE. The panel renders checkboxes for 38 groups it must not
//      hand-list — a second copy of the index would be a second truth.
//   3. THE `toolsPolicy` FOLD, which is a LIE A1 left behind and A3 owns.
//      A1 moved the authority for the tool allow/deny out of the `tools_policy`
//      COLUMN and into the grants object (`surface.ts` reads `toolGrantsFor`),
//      and `spawn_agent` was taught to fold its `tools` argument in (A2 §5). The
//      dashboard's own permissions editor was not: it still writes only the
//      column, so its Web Search / Web Browsing toggles have been writing to a
//      field no door reads. Ruling: nothing on the card may lie.
//
// RED AT `191bc84c`, measured: `agent/access/presets.ts` does not exist;
// `GET /api/access/catalog` 404s; and a `PUT /agents/:id {toolsPolicy}` leaves
// `grants.tools.deny` exactly as it was, so the toggle is a no-op.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-a3-panel', 'dojo.db'),
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

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { forgetAccessGrants, getAccessGrants, mayUseChannel, toolCategoryGranted } from '../read.js';
import { deriveLegacyGrants } from '../derive.js';
import { ACCESS_PRESETS, channelToolGroups } from '../presets.js';
import { accessRouter } from '../../../gateway/routes/access.js';
import { agentsRouter } from '../../../gateway/routes/agents.js';
import { TOOL_CATEGORIES } from '../../../tools/categories.js';
import { ACCESS_CHANNELS, MOST_RESTRICTIVE_GRANTS, stableGrantsText, channelTierOf } from '@dojo/shared';
import type { AccessChannel, AccessGrants } from '@dojo/shared';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DASH = path.resolve(SRC, '..', '..', 'dashboard', 'src');
const readSrc = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const readDash = (rel: string): string => fs.readFileSync(path.join(DASH, rel), 'utf8');
const db = (): Database.Database => mockDb.current!;

const LABELS = new Set(TOOL_CATEGORIES.map((c) => c.label));

function agent(id: string, classification: string, mutate?: (g: AccessGrants) => void): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, session_started_at)
     VALUES (?, ?, 'idle', ?, '1970-01-01')`,
  ).run(id, id, classification);
  forgetAccessGrants();
  const g = deriveLegacyGrants(id);
  if (mutate) mutate(g);
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
}

const put = (id: string, body: unknown): Promise<Response> =>
  agentsRouter.request(`/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  forgetAccessGrants();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 · THE FOUR PRESETS — the plan's own list, as server truth
// ════════════════════════════════════════════════════════════════════════════════

describe('the presets the plan names', () => {
  const byId = (id: string) => ACCESS_PRESETS.find((p) => p.id === id);

  it('⚠ ALL FOUR EXIST, IN THE ORDER AN OWNER MEETS THEM', () => {
    expect(ACCESS_PRESETS.map((p) => p.id)).toEqual(
      ['most_restrictive', 'reader', 'operator', 'full_trust'],
    );
    for (const p of ACCESS_PRESETS) {
      expect(p.label.length, `${p.id} is labelled`).toBeGreaterThan(0);
      expect(p.description.length, `${p.id} says what it does`).toBeGreaterThan(0);
    }
  });

  it('⚠ "Most restrictive" IS RULING 2\'S OBJECT, byte for byte — not a lookalike', () => {
    expect(stableGrantsText(byId('most_restrictive')!.grants))
      .toBe(stableGrantsText(MOST_RESTRICTIVE_GRANTS));
  });

  it('EVERY category a preset names is a real one — no preset can grant a phantom group', () => {
    for (const p of ACCESS_PRESETS) {
      const cats = p.grants.tools.categories;
      if (cats === '*') continue;
      for (const label of cats) {
        expect(LABELS.has(label), `preset "${p.id}" names "${label}", which is not in TOOL_CATEGORIES`).toBe(true);
      }
    }
  });

  it('⚠ NO PRESET GRANTS A CHANNEL WITHOUT THE TOOL GROUP THAT CHANNEL LIVES IN', () => {
    // A2 §6.2, handed up to A3: "a channel granted without its tool category is
    // inert". With the A3 rider that inertness became a REFUSAL at the executor,
    // which makes a preset that does it actively broken.
    for (const p of ACCESS_PRESETS) {
      for (const channel of ACCESS_CHANNELS) {
        if (channelTierOf(p.grants, channel) === 'none') continue;
        const needed = channelToolGroups(channel);
        expect(needed.length, `${channel} has at least one tool group`).toBeGreaterThan(0);
        const cats = p.grants.tools.categories;
        const holds = cats === '*' || needed.some((label) => cats.includes(label));
        expect(holds, `preset "${p.id}" grants ${channel} but not ${needed.join(' / ')}`).toBe(true);
      }
    }
  });

  it('⚠ "Reader" — Plaud and mail, read-only, and NO human channel', () => {
    const g = byId('reader')!.grants;
    expect(g.integrations.plaud).toBe(true);
    expect(g.integrations.google.agent).toBe('read');
    expect(g.integrations.google.user).toBe('read');
    expect(g.integrations.microsoft.agent).toBe('read');
    expect(g.integrations.microsoft.user).toBe('read');
    expect(g.channels.master).toBe(false);
    for (const channel of ACCESS_CHANNELS) expect(g.channels[channel]).toBe('none');
    // "read-only" is a claim about WRITES, so the send groups must be absent.
    expect(g.tools.categories).not.toContain('Communication');
  });

  it('⚠ "Operator" — exec and iMessage to the owner, and nobody else', () => {
    const g = byId('operator')!.grants;
    expect(g.tools.categories).toContain('File & System');   // exec lives here
    expect(g.tools.categories).toContain('Communication');   // imessage_send lives here
    expect(g.channels.master).toBe(true);
    expect(g.channels.imessage).toBe('owner');
    for (const channel of ACCESS_CHANNELS) {
      if (channel === 'imessage') continue;
      expect(g.channels[channel], `${channel} is not in the operator profile`).toBe('none');
    }
  });

  it('⚠ "Full trust" — primary-like: every group, every channel, the whole vault', () => {
    const g = byId('full_trust')!.grants;
    expect(g.tools.categories).toBe('*');
    expect(g.integrations.credentials).toBe(true);
    expect(g.integrations.plaud).toBe(true);
    expect(g.integrations.google.agent).toBe('full');
    expect(g.channels.master).toBe(true);
    for (const channel of ACCESS_CHANNELS) expect(g.channels[channel]).toBe('all');
  });

  it('the presets are DISTINCT — four names for four objects', () => {
    const texts = ACCESS_PRESETS.map((p) => stableGrantsText(p.grants));
    expect(new Set(texts).size).toBe(ACCESS_PRESETS.length);
  });

  it('a preset is applied through the ordinary door, so the walls still answer', () => {
    agent('operator', 'ronin', (g) => {
      Object.assign(g, JSON.parse(JSON.stringify(byId('operator')!.grants)));
    });
    expect(mayUseChannel('operator', 'imessage')).toBe(true);
    expect(mayUseChannel('operator', 'sms')).toBe(false);
    expect(toolCategoryGranted('operator', 'imessage_send')).toBe(true);
    expect(toolCategoryGranted('operator', 'web_search')).toBe(false);
  });

  it('the channel→group map is DERIVED from the index, not hand-listed', () => {
    // If somebody re-files `imessage_send` under a new label, this answer moves
    // with it. That is the property that keeps the panel's warning honest.
    for (const channel of ACCESS_CHANNELS) {
      for (const label of channelToolGroups(channel as AccessChannel)) {
        expect(LABELS.has(label), `${channel} maps to a real group`).toBe(true);
      }
    }
    expect(channelToolGroups('imessage')).toContain('Communication');
    expect(channelToolGroups('sms')).toContain('Twilio (SMS + Voice phone calls)');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · THE CATALOG — what the panel renders from
// ════════════════════════════════════════════════════════════════════════════════

describe('GET /catalog serves the checkbox list the panel draws', () => {
  const catalog = async (): Promise<Record<string, unknown>> => {
    const res = await accessRouter.request('/catalog');
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  };

  it('⚠ EVERY TOOL GROUP, FROM THE REAL INDEX', async () => {
    const data = await catalog();
    const groups = data.categories as Array<{ label: string; tools: number }>;
    expect(groups.length).toBe(TOOL_CATEGORIES.length);
    expect(groups.map((g) => g.label)).toEqual(TOOL_CATEGORIES.map((c) => c.label));
    for (const g of groups) expect(g.tools).toBeGreaterThan(0);
  });

  it('the presets ride with it, so the panel hand-writes no grant object', async () => {
    const data = await catalog();
    const presets = data.presets as Array<{ id: string; grants: AccessGrants }>;
    expect(presets.map((p) => p.id)).toEqual(ACCESS_PRESETS.map((p) => p.id));
    for (const p of presets) {
      expect(stableGrantsText(p.grants))
        .toBe(stableGrantsText(ACCESS_PRESETS.find((x) => x.id === p.id)!.grants));
    }
  });

  it('and the channel→group coupling, so the panel can SAY when a grant would be inert', async () => {
    const data = await catalog();
    const map = data.channelGroups as Record<string, string[]>;
    for (const channel of ACCESS_CHANNELS) {
      expect(map[channel], `${channel} is in the map`).toEqual(channelToolGroups(channel));
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · THE `toolsPolicy` FOLD — the lie A1 left behind
// ════════════════════════════════════════════════════════════════════════════════

describe('the permissions editor\'s tool toggles reach the authority again', () => {
  it('⚠ A `toolsPolicy` SAVE LANDS IN THE GRANTS, WHICH IS WHAT THE DOORS READ', async () => {
    agent('worker', 'apprentice');
    expect(getAccessGrants('worker').tools.deny).toEqual([]);

    const res = await put('worker', { toolsPolicy: { allow: [], deny: ['web_search', 'web_fetch'] } });
    expect(res.status).toBe(200);
    forgetAccessGrants();

    // The COLUMN still carries it — it is the legacy record and other readers
    // display it — and the GRANTS carry it too, which is where the surface strip
    // and the executor's re-check both look.
    const row = db().prepare('SELECT tools_policy FROM agents WHERE id = ?').get('worker') as { tools_policy: string };
    expect(JSON.parse(row.tools_policy).deny).toEqual(['web_search', 'web_fetch']);
    expect(getAccessGrants('worker').tools.deny).toEqual(['web_search', 'web_fetch']);
  });

  it('the fold writes an audit row, like every other grant change', async () => {
    agent('worker', 'apprentice');
    await put('worker', { toolsPolicy: { allow: [], deny: ['web_browse'] } });
    const rows = db().prepare(
      "SELECT detail FROM audit_log WHERE agent_id = 'worker' AND result = 'success'",
    ).all() as Array<{ detail: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toContain('tools.deny');
    expect(rows[0].detail).toContain('web_browse');
  });

  it('a save that changes nothing writes nothing — "it wrote a row" stays a fact', async () => {
    agent('worker', 'apprentice', (g) => { g.tools.deny = ['web_browse']; });
    await put('worker', { toolsPolicy: { allow: [], deny: ['web_browse'] } });
    const rows = db().prepare("SELECT id FROM audit_log WHERE agent_id = 'worker'").all();
    expect(rows.length).toBe(0);
  });

  it('⚠ AND A SAVE THAT CARRIES BOTH HALVES NO LONGER CLOBBERS THE GRANTS', async () => {
    // The ordering hazard A3 found: the A2 grant write ran BEFORE the column
    // batch, and the batch re-wrote `permissions` from a value read before it.
    // The old permissions editor sends `permissions` and `toolsPolicy` in ONE
    // body, so this is the live shape, not a contrived one.
    agent('worker', 'apprentice');
    const res = await put('worker', {
      permissions: { file_read: ['/tmp/**'], exec_allow: [] },
      toolsPolicy: { allow: [], deny: ['imessage_send'] },
      grants: { tools: { categories: ['Meta', 'File & System'] } },
    });
    expect(res.status).toBe(200);
    forgetAccessGrants();
    const g = getAccessGrants('worker');
    expect(g.tools.categories).toEqual(['Meta', 'File & System']);
    expect(g.tools.deny).toEqual(['imessage_send']);
    // …and the manifest half of the same document survived the grant write.
    const stored = JSON.parse(
      (db().prepare('SELECT permissions FROM agents WHERE id = ?').get('worker') as { permissions: string }).permissions,
    ) as Record<string, unknown>;
    expect(stored.file_read).toEqual(['/tmp/**']);
  });

  it('THE CONTROL: a save with neither field leaves the grants alone', async () => {
    agent('worker', 'apprentice', (g) => { g.tools.deny = ['web_browse']; });
    const before = stableGrantsText(getAccessGrants('worker'));
    await put('worker', { classification: 'ronin' });
    forgetAccessGrants();
    expect(stableGrantsText(getAccessGrants('worker'))).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 · THE PANEL ITSELF — the source census the Playwright run then DRIVES
// ════════════════════════════════════════════════════════════════════════════════

describe('the Access panel is bound to the real object, both directions', () => {
  const panel = (): string => readDash('components/AccessPanel.tsx');

  it('⚠ IT EXISTS, AND THE AGENT EDITOR MOUNTS IT', () => {
    expect(panel().length).toBeGreaterThan(0);
    const editor = readDash('pages/AgentConfigPanel.tsx');
    expect(editor).toContain('AccessPanel');
  });

  it('⚠ IT READS `effectiveGrants` FROM A2\'S GET AND WRITES `grants` THROUGH A2\'S PUT', () => {
    const src = panel();
    expect(src, 'reads the effective object, never the raw permissions blob').toContain('effectiveGrants');
    expect(src, 'writes through the validated grant door').toMatch(/grants:/);
  });

  it('the four sections the plan names are all present', () => {
    const src = panel();
    for (const section of ['Tools', 'Integrations', 'Channels', 'Techniques']) {
      expect(src, `the ${section} section`).toContain(section);
    }
  });

  it('⚠ THE ÜBER-TOGGLE GATES ITS CHILDREN — they do not exist beneath a false master', () => {
    const src = panel();
    expect(src).toContain('Allowed to talk to humans');
    // A3 drew the children DISABLED and dimmed; the owner's A5 order hides them
    // instead, which is strictly stronger — there is no control to reach at all.
    // The requirement is unchanged and still lives in `channelTierOf`: owner
    // ruling 1's "inert unless the master is on".
    expect(src).toMatch(/\{on && \(/);
    expect(src, 'no disabled-but-present per-channel row survives').not.toMatch(/disabled=\{!masterOn/);
  });

  it('⚠ A SENSEI THAT IS NOT THE PRIMARY GETS NO MASTER TOGGLE, AND IS TOLD WHY', () => {
    const src = panel();
    // `master === null` is the model's way of saying "has no such toggle", and
    // `hasMaster` is that question asked once. The panel must key on THAT and
    // never on the classification string — a sensei that was given a master
    // would otherwise lose its switch to a label.
    expect(src).toContain('hasMaster(');
    expect(src, 'the panel never decides access from the classification').not.toContain('classification');
    expect(src).toMatch(/through the main agent/i);
  });

  it('the panel never sends a channel section for an agent that has no master', () => {
    expect(panel()).toMatch(/hasMaster|master === null/);
  });
});

describe('the no-op toggles are gone from the permissions editor', () => {
  const editor = (): string => readDash('components/PermissionsEditor.tsx');

  it('⚠ "SEND iMESSAGES" IS GONE — it could never grant, and now there is a control that can', () => {
    // Census §9.1 G1: the toggle wrote `tools_policy.deny += imessage_send` when
    // off and removed it when on, but turning it ON granted nothing, because the
    // channel door refused every non-primary agent regardless. It was shown on
    // every agent's editor and was a no-op on all of them.
    const src = editor();
    expect(src).not.toContain('Send iMessages');
    // The deny-pusher itself, and the seeded deny in the new-sub-agent default.
    // (The tombstone comment naming what was deleted is the repo's own practice
    // and is exactly what a grep for the old behaviour should find.)
    expect(src).not.toMatch(/push\('imessage_send'\)/);
    expect(src).not.toMatch(/deny: \[[^\]]*imessage_send/);
  });

  it('the editor keeps the toggles that DO something — this is a deletion, not a purge', () => {
    const src = editor();
    for (const kept of ['Read Files', 'Run Terminal Commands', 'Web Search', 'Create Sub-Agents']) {
      expect(src, `${kept} is a real control and stays`).toContain(kept);
    }
  });

  it('and the defaults it exports no longer name the tool it cannot govern', () => {
    expect(editor()).not.toMatch(/DEFAULT_SUBAGENT_TOOLS_POLICY[\s\S]{0,200}imessage_send/);
  });
});

describe('the server states the coupling the panel warns about', () => {
  it('the catalog route is mounted, so the panel is not talking to a phantom', () => {
    expect(readSrc('gateway/server.ts')).toContain('accessRouter');
  });
});
