// UX-REPAIR ROUND 12 / T50 — A RENAME REACHES THE SOUL, THROUGH ONE DOOR.
//
// ── THE OWNER'S RULING (ruling 1 of the twelve) ──
// "RE-FILL ON RENAME": when an agent's display name changes, stored souls that reference the
// OLD name get the rename applied. Exact word-boundary replacement of the old display name
// only; an audit note records old→new and the count; NO re-seed; NO other text touched; and
// OWNER-AUTHORED souls get the same treatment — the owner renamed the agent and wants the
// souls to follow.
//
// ── WHAT STEP-0 FOUND, AND WHY THIS FILE PINS A MERGER RATHER THAN A HOOK ──
// Renames flowed through THREE inline `UPDATE agents SET name` / config writes:
//   1. `gateway/routes/agents.ts`  PUT /api/agents/:id        — the owner's Settings card
//   2. `agent/tools/cat/agents.ts` update_agent               — the model
//   3. `gateway/routes/config.ts`  PUT /settings/<role>_agent_name
// and the THIRD is the decisive one. `substitutePlatformNames` bakes `getPMAgentName()` /
// `getTrainerAgentName()` / `getPrimaryAgentName()` INTO the stored soul at seed time, and
// those getters read the CONFIG key, not the row — so the souls that actually carry a display
// name are exactly the ones renamed by the door that never touches `agents.name` at all.
// Measured on the owner's box: `PM-SOUL.md` 13,922 B and `TRAINER-SOUL.md` 8,057 B, names
// substituted, zero `{{` left.
//
// So the three writes MERGE into one `renameAgent` door — the `writeAgentStatus` precedent,
// which absorbed five byte-shaped copies of a status write for the same reason — and the
// re-fill hangs there, where every rename must pass.
//
// ── THE RULE THIS FILE IS ──
//   1. all three doors rename, and the stored soul follows, on every one of them;
//   2. the config door's role-name path is the case that MUST work;
//   3. WORD BOUNDARY: an agent called "Max" never rewrites "Maximum", "Maxwell" or "climax";
//   4. souls that do not name the agent are not touched at all — not one byte, not the mtime;
//   5. a `{{…}}`-carrying soul is NOT rename-patched: it is left to the existing re-seed rule,
//      which is a different repair for a different defect;
//   6. an audit note records old→new and the per-soul count;
//   7. and there is exactly ONE rename write path in the tree, so a fourth door cannot grow back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const HOME_DIR_NAME = 'dojo-t50-rename-souls';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-t50-rename-souls');
  return { ...real, homedir, default: { ...real, homedir } };
});

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { renameAgent } from '../agent-rename.js';
import { readSoulFile, soulFileForAgent } from '../assembler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const HOME = path.join(realOs.tmpdir(), HOME_DIR_NAME);
const PROMPTS = path.join(HOME, '.dojo', 'prompts');

const PRIMARY = 'kevin';
const PM = 'kelly';
const TRAINER = 'ticky';
const HEALER = 'healer';
const IMAGINER = 'imaginer';
const SUB = 'maxbot';

const soulPath = (f: string): string => path.join(PROMPTS, f);
const readSoul = (f: string): string => fs.readFileSync(soulPath(f), 'utf-8');

function seedAgent(id: string, name: string, charter: string | null = null): void {
  mockDb.current!
    .prepare("INSERT INTO agents (id, name, status, charter) VALUES (?, ?, 'idle', ?)")
    .run(id, name, charter);
}

function setConfig(key: string, value: string): void {
  mockDb.current!
    .prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

const getConfig = (key: string): string | undefined =>
  (mockDb.current!.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value;

const agentName = (id: string): string =>
  (mockDb.current!.prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string }).name;

beforeEach(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(PROMPTS, { recursive: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  mockDb.current = new Database(':memory:');
  runMigrations();
  setConfig('primary_agent_id', PRIMARY);
  setConfig('primary_agent_name', 'Kevin');
  setConfig('pm_agent_id', PM);
  setConfig('pm_agent_name', 'Kelly');
  setConfig('trainer_agent_id', TRAINER);
  setConfig('trainer_agent_name', 'Ticky');
  // T59 (W42): two more file-backed souls to re-fill.
  setConfig('healer_agent_id', HEALER);
  setConfig('healer_agent_name', 'Healer');
  setConfig('imaginer_agent_id', IMAGINER);
  setConfig('imaginer_agent_name', 'Iris');
  setConfig('owner_name', 'David');
  const platform = await import('../../config/platform.js');
  platform.clearPlatformConfigCache();
  seedAgent(PRIMARY, 'Kevin');
  seedAgent(PM, 'Kelly');
  seedAgent(TRAINER, 'Ticky');
  seedAgent(HEALER, 'Healer');
  seedAgent(IMAGINER, 'Iris');
  seedAgent(SUB, 'Max');

  // The stored souls as a worn-in box carries them: SUBSTITUTED, no placeholders left.
  fs.writeFileSync(soulPath('SOUL.md'),
    '# Kevin\n\nYou are Kevin, the Dojo Master. Kelly runs the tracker; ask Kelly before you plan.\n');
  fs.writeFileSync(soulPath('PM-SOUL.md'),
    '# Kelly — Project Manager\n\nYou are Kelly, the project manager. Escalate to Kevin.\nKelly does not have iMessage.\n');
  fs.writeFileSync(soulPath('TRAINER-SOUL.md'),
    '# Ticky — Trainer\n\nYou are Ticky, the technique trainer. Report to Kevin.\n');
  fs.writeFileSync(soulPath('MAXBOT-SOUL.md'),
    '# Max\n\nYou are Max. Max reviews the Maximum-effort queue with Maxwell, and never peaks at climax.\n');
  // T59 (W42): the two souls this task made file-backed, in the shape their templates carry.
  // HEALER-SOUL.md names its agent in PROSE ("You are the Healer") rather than through a
  // placeholder, so the rename re-fill is the ONLY thing that can make a renamed Healer's own
  // doctrine call it by its name.
  fs.writeFileSync(soulPath('HEALER-SOUL.md'),
    '# Identity\n\nYou are the Healer, the dojo\'s self-healing agent. Escalate to Kevin.\n');
  fs.writeFileSync(soulPath('IMAGINER-SOUL.md'),
    '# Identity\n\nYou are Iris, the image specialist. Ask Kevin to run image_create.\n');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ═══════════ THE THREE DOORS ═══════════

describe('a rename reaches the soul, through every door', () => {
  it('THE DECISIVE SHAPE — the CONFIG door (PM): pm_agent_name changes and the stored soul follows', async () => {
    const { configRouter } = await import('../../gateway/routes/config.js');
    const res = await configRouter.request('/settings/pm_agent_name', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'Karen' }),
    });
    expect(res.status).toBe(200);

    // The three facts a rename must leave behind, together.
    expect(getConfig('pm_agent_name')).toBe('Karen');
    expect(agentName(PM)).toBe('Karen');
    const soul = readSoul('PM-SOUL.md');
    expect(soul).toContain('You are Karen, the project manager');
    expect(soul).toContain('Karen does not have iMessage');
    expect(soul).not.toContain('Kelly');
  });

  it('the CONFIG door (Trainer): the other measured casualty follows too', async () => {
    const { configRouter } = await import('../../gateway/routes/config.js');
    await configRouter.request('/settings/trainer_agent_name', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'Tock' }),
    });

    expect(agentName(TRAINER)).toBe('Tock');
    expect(readSoul('TRAINER-SOUL.md')).toContain('You are Tock, the technique trainer');
    expect(readSoul('TRAINER-SOUL.md')).not.toContain('Ticky');
  });

  it('the SETTINGS door: PUT /api/agents/:id renames and the soul follows', async () => {
    const { agentsRouter } = await import('../../gateway/routes/agents.js');
    const res = await agentsRouter.request(`/${PM}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Karen' }),
    });
    expect(res.status).toBe(200);

    expect(agentName(PM)).toBe('Karen');
    expect(getConfig('pm_agent_name')).toBe('Karen');       // the role name moves WITH the row
    expect(readSoul('PM-SOUL.md')).toContain('You are Karen');
  });

  it('the TOOL door: update_agent renames and the soul follows', async () => {
    const { agentsHandlers } = await import('../../agent/tools/cat/agents.js');
    const out = await agentsHandlers['update_agent']!({
      agentId: PRIMARY, args: { agent_id: SUB, name: 'Rex' },
    } as never);

    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('name: "Max" → "Rex"');    // the door's own words, unchanged
    expect(agentName(SUB)).toBe('Rex');
    expect(readSoul('MAXBOT-SOUL.md')).toContain('You are Rex');
  });
});

// ═══════════ THE DISCIPLINE ═══════════

describe('the re-fill is exact', () => {
  it('MANDATORY CONTROL — a common word: "Max" never rewrites Maximum, Maxwell or climax', () => {
    const out = renameAgent(SUB, 'Rex');

    const soul = readSoul('MAXBOT-SOUL.md');
    expect(soul).toBe('# Rex\n\nYou are Rex. Rex reviews the Maximum-effort queue with Maxwell, and never peaks at climax.\n');
    expect(soul).toContain('Maximum-effort');
    expect(soul).toContain('Maxwell');
    expect(soul).toContain('climax');
    expect(out.souls.find((s) => s.file === 'MAXBOT-SOUL.md')?.replacements).toBe(3);
  });

  it('CONTROL: unrelated souls are not touched — not a byte, not the mtime', () => {
    const before = fs.readFileSync(soulPath('TRAINER-SOUL.md'));
    const beforeStat = fs.statSync(soulPath('TRAINER-SOUL.md')).mtimeMs;

    renameAgent(SUB, 'Rex');   // "Max" appears nowhere in the trainer's soul

    expect(fs.readFileSync(soulPath('TRAINER-SOUL.md'))).toEqual(before);
    expect(fs.statSync(soulPath('TRAINER-SOUL.md')).mtimeMs).toBe(beforeStat);
    expect(renameAgent(TRAINER, 'Tock').souls.map((s) => s.file)).not.toContain('MAXBOT-SOUL.md');
  });

  it('EVERY soul that names the agent follows, not just the agent\'s own', () => {
    const out = renameAgent(PM, 'Karen');

    // The primary's own SOUL.md names the PM twice. The owner authored it; the ruling says it follows.
    expect(readSoul('SOUL.md')).toBe(
      '# Kevin\n\nYou are Kevin, the Dojo Master. Karen runs the tracker; ask Karen before you plan.\n');
    expect(out.souls.find((s) => s.file === 'SOUL.md')?.replacements).toBe(2);
    expect(out.souls.find((s) => s.file === 'PM-SOUL.md')?.replacements).toBe(3);
  });

  it('CONTROL: a `{{…}}`-carrying soul is LEFT to the existing re-seed rule, not rename-patched', () => {
    // The W24/W25 shape: an engine-seeded stub that never passed a substituting writer.
    fs.writeFileSync(soulPath('PM-SOUL.md'), '# {{pm_agent_name}}\n\nYou are {{pm_agent_name}}, and Kelly is stale.\n');

    const out = renameAgent(PM, 'Karen');

    expect(out.skippedUnsubstituted).toContain('PM-SOUL.md');
    expect(out.souls.map((s) => s.file)).not.toContain('PM-SOUL.md');
    expect(readSoul('PM-SOUL.md')).toContain('{{pm_agent_name}}');   // untouched by the rename

    // …and the EXISTING rule still repairs it on the next read, now with the NEW name.
    const seeded = readSoulFile(soulFileForAgent(PM)!);
    expect(seeded).not.toContain('{{');
    expect(seeded).toContain('Karen');
  });

  it('a no-op rename writes nothing at all', () => {
    const before = fs.readFileSync(soulPath('PM-SOUL.md'));
    expect(renameAgent(PM, 'Kelly').renamed).toBe(false);
    expect(renameAgent(PM, '   ').renamed).toBe(false);
    expect(fs.readFileSync(soulPath('PM-SOUL.md'))).toEqual(before);
  });

  it('the audit note records old→new and the count, per soul touched', () => {
    renameAgent(PM, 'Karen');

    // `action_type` is `file_write`, not a seventh CHECK value invented for one row — the
    // durable artifact of a re-fill IS the soul-file write, and `detail.kind` names the event.
    const row = mockDb.current!.prepare(
      "SELECT agent_id, action_type, target, result, detail FROM audit_log WHERE detail LIKE '%agent_rename%'",
    ).get() as { agent_id: string; action_type: string; target: string; result: string; detail: string };

    expect(row.agent_id).toBe(PM);
    expect(row.action_type).toBe('file_write');
    expect(row.target).toBe('Kelly → Karen');
    expect(row.result).toBe('success');
    const detail = JSON.parse(row.detail) as { kind: string; oldName: string; newName: string; replacements: number; souls: Array<{ file: string; replacements: number }> };
    expect(detail.kind).toBe('agent_rename');
    expect(detail.oldName).toBe('Kelly');
    expect(detail.newName).toBe('Karen');
    expect(detail.replacements).toBe(5);                                   // 3 in PM-SOUL.md + 2 in SOUL.md
    expect(detail.souls.map((s) => s.file).sort()).toEqual(['PM-SOUL.md', 'SOUL.md']);
  });

  it('CONTROL: a rename that touched no soul writes no audit row — the log line is the record', () => {
    seedAgent('nobody', 'Nemo');
    const out = renameAgent('nobody', 'Nova');

    expect(out.renamed).toBe(true);
    expect(out.souls).toEqual([]);
    expect(agentName('nobody')).toBe('Nova');
    expect(mockDb.current!.prepare("SELECT COUNT(*) c FROM audit_log WHERE detail LIKE '%agent_rename%'")
      .get() as { c: number }).toEqual({ c: 0 });
  });

  it('ZERO TEMPLATE AND DEFAULT BYTES: the shipped templates and the in-code stubs never move', () => {
    const snapshot = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const f of fs.readdirSync(path.join(REPO_ROOT, 'templates'))) {
        out[f] = fs.readFileSync(path.join(REPO_ROOT, 'templates', f), 'utf-8');
      }
      out['prompt/templates.ts'] = fs.readFileSync(path.join(REPO_ROOT, 'packages/server/src/prompt/templates.ts'), 'utf-8');
      return out;
    };
    const before = snapshot();
    renameAgent(PM, 'Karen');
    renameAgent(PRIMARY, 'Kev');
    expect(snapshot()).toEqual(before);
  });
});

// ═══════════ T59 (W42): THE RE-FILL COVERS THE SOULS T59 ADDED ═══════════
//
// The T59 ruling says the rename door's re-fill must reach the new files, and that the
// `readdir` FILTER be verified rather than assumed. It is `f === 'SOUL.md' || f.endsWith(
// '-SOUL.md')` — `HEALER-SOUL.md` and `IMAGINER-SOUL.md` match the second arm — so this
// needed no code change at all. That is exactly why it needs a test: a covered-by-accident
// property with nothing asserting it is one refactor away from being covered by nothing.

describe('the re-fill reaches the souls T59 made file-backed', () => {
  it('THE CONFIG DOOR (Healer): healer_agent_name changes and the stored soul follows', async () => {
    const { configRouter } = await import('../../gateway/routes/config.js');
    const res = await configRouter.request('/settings/healer_agent_name', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'Medic' }),
    });
    expect(res.status).toBe(200);

    expect(getConfig('healer_agent_name')).toBe('Medic');
    expect(agentName(HEALER)).toBe('Medic');
    expect(readSoul('HEALER-SOUL.md')).toContain('You are the Medic, the dojo');
    expect(readSoul('HEALER-SOUL.md')).not.toContain('Healer');
  });

  it('THE CONFIG DOOR (Imaginer): imaginer_agent_name changes and the stored soul follows', async () => {
    const { configRouter } = await import('../../gateway/routes/config.js');
    await configRouter.request('/settings/imaginer_agent_name', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'Vega' }),
    });

    expect(agentName(IMAGINER)).toBe('Vega');
    expect(readSoul('IMAGINER-SOUL.md')).toContain('You are Vega, the image specialist');
    expect(readSoul('IMAGINER-SOUL.md')).not.toContain('Iris');
  });

  it('THE FILTER, ASSERTED: every file `soulFileForAgent` can name is one `storedSoulFiles` reaches', () => {
    // Renaming the PRIMARY touches every soul that mentions it — which is how we see the whole
    // set the readdir filter admits, in one call, without reaching into a private function.
    const out = renameAgent(PRIMARY, 'Kev');
    const touched = out.souls.map((s) => s.file).sort();

    expect(touched).toEqual([
      'HEALER-SOUL.md', 'IMAGINER-SOUL.md', 'PM-SOUL.md', 'SOUL.md', 'TRAINER-SOUL.md',
    ]);
    // MAXBOT-SOUL.md is absent because it never names the primary — the filter admits it, the
    // no-write rule skips it. Both halves matter, so both are said here.
    expect(touched).not.toContain('MAXBOT-SOUL.md');
    // And the declared file for each platform soul is in that set — the pin the ruling asks for.
    for (const id of [PM, TRAINER, HEALER, IMAGINER]) {
      expect(touched).toContain(soulFileForAgent(id)!.file);
    }
  });

  it('CONTROL: the word-boundary rule holds on the new files too — "Iris" never rewrites "Irish"', () => {
    fs.writeFileSync(soulPath('IMAGINER-SOUL.md'),
      '# Iris\n\nIris draws. Iris is not Irish, and Iris-adjacent is not Iris.\n');

    const out = renameAgent(IMAGINER, 'Vega');
    const soul = readSoul('IMAGINER-SOUL.md');

    expect(soul).toContain('Vega is not Irish');
    expect(soul).toContain('Vega-adjacent is not Vega');   // hyphen is not a letter/digit/underscore
    expect(soul).not.toMatch(/\bIris\b/);
    expect(out.souls.find((s) => s.file === 'IMAGINER-SOUL.md')?.replacements).toBe(5);
  });

  it('CONTROL: renaming the Healer leaves the Imaginer and the primary byte-identical, mtime included', () => {
    const watched = ['IMAGINER-SOUL.md', 'SOUL.md', 'PM-SOUL.md', 'TRAINER-SOUL.md'];
    const before = watched.map((f) => [fs.readFileSync(soulPath(f)), fs.statSync(soulPath(f)).mtimeMs] as const);

    renameAgent(HEALER, 'Medic');

    watched.forEach((f, i) => {
      expect(fs.readFileSync(soulPath(f))).toEqual(before[i][0]);
      expect(fs.statSync(soulPath(f)).mtimeMs).toBe(before[i][1]);
    });
  });
});

// ═══════════ THE MERGER, PINNED ═══════════

describe('there is exactly one rename door', () => {
  // The five DECLARED boot re-sync upserts. They do not rename: each writes the CONFIGURED
  // platform name back onto its own row at boot, and that config value is now owned by
  // `renameAgent`. Declared here rather than excluded silently, so a SIXTH one is a finding.
  const DECLARED_RESYNC = [
    'packages/server/src/healer/healer-agent.ts',
    'packages/server/src/imaginer/imaginer-agent.ts',
    'packages/server/src/techniques/trainer-agent.ts',
    'packages/server/src/tracker/pm-agent.ts',
    'packages/server/src/vault/maintenance.ts',
  ];
  const THE_DOOR = 'packages/server/src/prompt/agent-rename.ts';

  it('no `agents.name` write exists outside the one door and the declared boot re-syncs', () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const src = fs.readFileSync(p, 'utf-8');
        const rel = path.relative(REPO_ROOT, p);
        // Multi-line aware: the shape a one-line grep cannot see, and the shape three of
        // these writes actually had.
        const re = /UPDATE\s+agents\s+SET([\s\S]{0,400}?)(WHERE|`|")/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) if (/\bname\s*=/.test(m[1])) { found.push(rel); break; }
        // …and the DYNAMIC builder, which is how the settings door hid from that regex.
        if (/updates\.push\('name = \?'\)/.test(src)) found.push(rel);
      }
    };
    walk(path.join(REPO_ROOT, 'packages/server/src'));

    const unexpected = [...new Set(found)].filter((f) => f !== THE_DOOR && !DECLARED_RESYNC.includes(f)).sort();
    expect(unexpected).toEqual([]);
    expect([...new Set(found)]).toContain(THE_DOOR);
  });

  it('every door CALLS the one function rather than carrying its own copy', () => {
    for (const door of [
      'packages/server/src/gateway/routes/agents.ts',
      'packages/server/src/gateway/routes/config.ts',
      'packages/server/src/agent/tools/cat/agents.ts',
    ]) {
      expect(fs.readFileSync(path.join(REPO_ROOT, door), 'utf-8')).toContain('renameAgent');
    }
  });
});
