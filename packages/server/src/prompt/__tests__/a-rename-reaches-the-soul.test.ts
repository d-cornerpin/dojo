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

// ⚠ PER-RUN *AND* PER-WORKER, INSIDE THE RUN ROOT (backlog 2026-09-26, lanes 3-4: "a FIXED
// os.tmpdir() path (needs per-run suffix) ... the temp-dir ENOENT under concurrent lanes —
// same family"; the twin was fixed in `t97`, this is its hand-up).
//
// The path was a CONSTANT under the shared system temp dir, and `beforeEach` opens with
// `rmSync(HOME, {recursive:true})`: two workers running this file deleted each other's fixture
// mid-run and the loser failed with ENOENT on a file it had just written. A `process.pid`
// suffix alone — what this file carried until now — fixed the two-worker case and left two
// real ones. (i) The directory sat OUTSIDE `DOJO_TEST_HOME_ROOT`, the per-run root
// `vitest.config.ts` computes and `vitest.global-setup.ts` removes at the end of the run, so
// every run stranded a tree in the system temp dir forever. (ii) Those stranded trees are what
// make pid REUSE reachable: seven worktrees run this suite on one box, the OS recycles pids,
// and `beforeEach`'s `rmSync` then deletes a directory this process does not own.
//
// So the root is the RUN ROOT and the leaf carries the worker id as well as the pid — the
// SAME shape and the same fallback `vitest.setup.ts:36-42` uses for every worker's home, which
// is the point: one convention for scratch homes, not a second one invented here. Both halves
// are computed twice (here and in the HOISTED factory below, which cannot see this module's
// bindings) and `beforeEach`'s first act is the clause that refuses a drift between the copies.
const TEST_HOME_ROOT = process.env.DOJO_TEST_HOME_ROOT && process.env.DOJO_TEST_HOME_ROOT !== ''
  ? process.env.DOJO_TEST_HOME_ROOT
  : path.join(realOs.tmpdir(), 'dojo-test-homes', 'orphan-run');
const WORKER_ID = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 'x';
const HOME_DIR_NAME = `t50-rename-souls-w${WORKER_ID}-${process.pid}`;

// The platform resolves `~/.dojo` in exactly one place — `src/home.ts` — so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  // The other copy of the two the `beforeEach` drift clause holds together.
  const root = process.env.DOJO_TEST_HOME_ROOT && process.env.DOJO_TEST_HOME_ROOT !== ''
    ? process.env.DOJO_TEST_HOME_ROOT
    : p.join(o.tmpdir(), 'dojo-test-homes', 'orphan-run');
  const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 'x';
  const dir = p.join(root, `t50-rename-souls-w${worker}-${process.pid}`);
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
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
import { homeDir } from '../../home.js';
import { configRouter } from '../../gateway/routes/config.js';
import { agentsRouter } from '../../gateway/routes/agents.js';
import { agentsHandlers } from '../../agent/tools/cat/agents.js';
import * as platform from '../../config/platform.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const HOME = path.join(TEST_HOME_ROOT, HOME_DIR_NAME);
const PROMPTS = path.join(HOME, '.dojo', 'prompts');

const PRIMARY = FXID.n4;
const PM = FXID.n5;
const TRAINER = FXID.n6;
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
  // The directory name is written TWICE — here and in the hoisted factory, which cannot see
  // this module's bindings. This refuses a drift between the two copies rather than silently
  // exercising a directory the platform under test is not using.
  if (homeDir() !== HOME) {
    throw new Error(`fixture drift: the home.js mock resolves ${homeDir()}, this test writes ${HOME}`);
  }
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(PROMPTS, { recursive: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  mockDb.current = new Database(':memory:');
  runMigrations();
  setConfig('primary_agent_id', PRIMARY);
  setConfig('primary_agent_name', FX.n4);
  setConfig('pm_agent_id', PM);
  setConfig('pm_agent_name', FX.n5);
  setConfig('trainer_agent_id', TRAINER);
  setConfig('trainer_agent_name', FX.n6);
  // T59 (W42): two more file-backed souls to re-fill.
  setConfig('healer_agent_id', HEALER);
  setConfig('healer_agent_name', 'Healer');
  setConfig('imaginer_agent_id', IMAGINER);
  setConfig('imaginer_agent_name', 'Iris');
  setConfig('owner_name', FX.n11);
  platform.clearPlatformConfigCache();
  seedAgent(PRIMARY, FX.n4);
  seedAgent(PM, FX.n5);
  seedAgent(TRAINER, FX.n6);
  seedAgent(HEALER, 'Healer');
  seedAgent(IMAGINER, 'Iris');
  seedAgent(SUB, 'Max');

  // The stored souls as a worn-in box carries them: SUBSTITUTED, no placeholders left.
  fs.writeFileSync(soulPath('SOUL.md'),
    `# ${FX.n4}\n\nYou are ${FX.n4}, the Dojo Master. ${FX.n5} runs the tracker; ask ${FX.n5} before you plan.\n`);
  fs.writeFileSync(soulPath('PM-SOUL.md'),
    `# ${FX.n5} — Project Manager\n\nYou are ${FX.n5}, the project manager. Escalate to ${FX.n4}.\nQuilba does not have iMessage.\n`);
  fs.writeFileSync(soulPath('TRAINER-SOUL.md'),
    `# ${FX.n6} — Trainer\n\nYou are ${FX.n6}, the technique trainer. Report to ${FX.n4}.\n`);
  fs.writeFileSync(soulPath('MAXBOT-SOUL.md'),
    '# Max\n\nYou are Max. Max reviews the Maximum-effort queue with Maxwell, and never peaks at climax.\n');
  // T59 (W42): the two souls this task made file-backed, in the shape their templates carry.
  // HEALER-SOUL.md names its agent in PROSE ("You are the Healer") rather than through a
  // placeholder, so the rename re-fill is the ONLY thing that can make a renamed Healer's own
  // doctrine call it by its name.
  fs.writeFileSync(soulPath('HEALER-SOUL.md'),
    `# Identity\n\nYou are the Healer, the dojo\'s self-healing agent. Escalate to ${FX.n4}.\n`);
  fs.writeFileSync(soulPath('IMAGINER-SOUL.md'),
    `# Identity\n\nYou are Iris, the image specialist. Ask ${FX.n4} to run image_create.\n`);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ═══════════ THE THREE DOORS ═══════════

describe('a rename reaches the soul, through every door', () => {
  it('THE DECISIVE SHAPE — the CONFIG door (PM): pm_agent_name changes and the stored soul follows', async () => {
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
    expect(soul).not.toContain(FX.n5);
  });

  it('the CONFIG door (Trainer): the other measured casualty follows too', async () => {
    await configRouter.request('/settings/trainer_agent_name', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'Tock' }),
    });

    expect(agentName(TRAINER)).toBe('Tock');
    expect(readSoul('TRAINER-SOUL.md')).toContain('You are Tock, the technique trainer');
    expect(readSoul('TRAINER-SOUL.md')).not.toContain(FX.n6);
  });

  it('the SETTINGS door: PUT /api/agents/:id renames and the soul follows', async () => {
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
    const out = await agentsHandlers['update_agent']!({
      agentId: PRIMARY, args: { agent_id: SUB, name: FX.n7 },
    } as never);

    expect(out.isError).toBeFalsy();
    expect(out.content).toContain(`name: "Max" → "${FX.n7}"`);    // the door's own words, unchanged
    expect(agentName(SUB)).toBe(FX.n7);
    expect(readSoul('MAXBOT-SOUL.md')).toContain(`You are ${FX.n7}`);
  });
});

// ═══════════ THE DISCIPLINE ═══════════

describe('the re-fill is exact', () => {
  it('MANDATORY CONTROL — a common word: "Max" never rewrites Maximum, Maxwell or climax', () => {
    const out = renameAgent(SUB, FX.n7);

    const soul = readSoul('MAXBOT-SOUL.md');
    expect(soul).toBe(`# ${FX.n7}\n\nYou are ${FX.n7}. ${FX.n7} reviews the Maximum-effort queue with Maxwell, and never peaks at climax.\n`);
    expect(soul).toContain('Maximum-effort');
    expect(soul).toContain('Maxwell');
    expect(soul).toContain('climax');
    expect(out.souls.find((s) => s.file === 'MAXBOT-SOUL.md')?.replacements).toBe(3);
  });

  it('CONTROL: unrelated souls are not touched — not a byte, not the mtime', () => {
    const before = fs.readFileSync(soulPath('TRAINER-SOUL.md'));
    const beforeStat = fs.statSync(soulPath('TRAINER-SOUL.md')).mtimeMs;

    renameAgent(SUB, FX.n7);   // "Max" appears nowhere in the trainer's soul

    expect(fs.readFileSync(soulPath('TRAINER-SOUL.md'))).toEqual(before);
    expect(fs.statSync(soulPath('TRAINER-SOUL.md')).mtimeMs).toBe(beforeStat);
    expect(renameAgent(TRAINER, 'Tock').souls.map((s) => s.file)).not.toContain('MAXBOT-SOUL.md');
  });

  it('EVERY soul that names the agent follows, not just the agent\'s own', () => {
    const out = renameAgent(PM, 'Karen');

    // The primary's own SOUL.md names the PM twice. The owner authored it; the ruling says it follows.
    expect(readSoul('SOUL.md')).toBe(
      `# ${FX.n4}\n\nYou are ${FX.n4}, the Dojo Master. Karen runs the tracker; ask Karen before you plan.\n`);
    expect(out.souls.find((s) => s.file === 'SOUL.md')?.replacements).toBe(2);
    expect(out.souls.find((s) => s.file === 'PM-SOUL.md')?.replacements).toBe(3);
  });

  it('CONTROL: a `{{…}}`-carrying soul is LEFT to the existing re-seed rule, not rename-patched', () => {
    // The W24/W25 shape: an engine-seeded stub that never passed a substituting writer.
    fs.writeFileSync(soulPath('PM-SOUL.md'), `# {{pm_agent_name}}\n\nYou are {{pm_agent_name}}, and ${FX.n5} is stale.\n`);

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
    expect(renameAgent(PM, FX.n5).renamed).toBe(false);
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
    expect(row.target).toBe(`${FX.n5} → Karen`);
    expect(row.result).toBe('success');
    const detail = JSON.parse(row.detail) as { kind: string; oldName: string; newName: string; replacements: number; souls: Array<{ file: string; replacements: number }> };
    expect(detail.kind).toBe('agent_rename');
    expect(detail.oldName).toBe(FX.n5);
    expect(detail.newName).toBe('Karen');
    expect(detail.replacements).toBe(5);                                   // 3 in PM-SOUL.md + 2 in SOUL.md
    expect(detail.souls.map((s) => s.file).sort()).toEqual(['PM-SOUL.md', 'SOUL.md']);
  });

  it('CONTROL: a rename that touched no soul writes no audit row — the log line is the record', () => {
    seedAgent('nobody', 'Nemo');
    const out = renameAgent('nobody', FX.n9);

    expect(out.renamed).toBe(true);
    expect(out.souls).toEqual([]);
    expect(agentName('nobody')).toBe(FX.n9);
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

// ═══════════ E21 PARKED MINOR — A RENAME MUST NOT MINT A SECOND AGENT THE CASE-INSENSITIVE
// LOOKUP CANNOT TELL APART ═══════════
//
// E21 made every name lookup case-insensitive, so "helper" reaches "Helper". But nothing stopped
// an agent from being RENAMED to a name that differs from another live agent's name only by case —
// and then the lookup could not tell them apart. The one rename door must refuse that, while an
// agent renaming to a DIFFERENT CAPITALISATION OF ITS OWN NAME stays allowed (the owner may
// decide "Helper" is now "helper"), and an exact byte-identical duplicate keeps its pre-existing
// behaviour. The refusal is surfaced in each caller's own door style.

describe('a rename refuses a case-variant clash with another live agent', () => {
  it('renameAgent refuses when the new name differs from another live agent only by case', () => {
    seedAgent('clash', 'Helper');
    const out = renameAgent(SUB, 'helper');   // SUB is 'Max'; 'helper' clashes with 'Helper'
    expect(out.renamed).toBe(false);
    expect(out.refusal).toBe('An agent named "Helper" already exists; names are matched without regard to capital letters.');
    expect(agentName(SUB)).toBe('Max');   // the rename wrote nothing
  });

  it('renaming an agent to a different capitalisation of ITS OWN name is allowed', () => {
    seedAgent('self', 'Helper');
    const out = renameAgent('self', 'helper');
    expect(out.renamed).toBe(true);
    expect(out.refusal).toBeUndefined();
    expect(agentName('self')).toBe('helper');
  });

  it('a terminated clashing agent does not block a rename', () => {
    seedAgent('dead', 'Helper');
    mockDb.current!.prepare("UPDATE agents SET status = 'terminated' WHERE id = 'dead'").run();
    const out = renameAgent(SUB, 'helper');
    expect(out.renamed).toBe(true);
    expect(out.refusal).toBeUndefined();
    expect(agentName(SUB)).toBe('helper');
  });

  it('THE SETTINGS door refuses and returns 400, in its own style', async () => {
    seedAgent('clash', 'Helper');
    const res = await agentsRouter.request(`/${PM}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'helper' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error)
      .toBe('An agent named "Helper" already exists; names are matched without regard to capital letters.');
    expect(agentName(PM)).toBe(FX.n5);   // untouched
  });

  it('THE CONFIG door refuses and returns 400, before the generic upsert', async () => {
    seedAgent('clash', 'Helper');
    const res = await configRouter.request('/settings/pm_agent_name', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'helper' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error)
      .toBe('An agent named "Helper" already exists; names are matched without regard to capital letters.');
    expect(getConfig('pm_agent_name')).toBe(FX.n5);   // the config key did NOT move
    expect(agentName(PM)).toBe(FX.n5);                // the row did NOT move
  });

  it('THE TOOL door refuses and reports the plain message', async () => {
    seedAgent('clash', 'Helper');
    const out = await agentsHandlers['update_agent']!({
      agentId: PRIMARY, args: { agent_id: SUB, name: 'helper' },
    } as never);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('An agent named "Helper" already exists; names are matched without regard to capital letters.');
    expect(agentName(SUB)).toBe('Max');   // untouched
  });
});

// ═══════════ THE MERGER, PINNED ═══════════

describe('there is exactly one rename door', () => {
  // The five DECLARED boot re-sync upserts. They do not rename: each writes the CONFIGURED
  // platform name back onto its own row at boot, and that config value is now owned by
  // `renameAgent`. Declared here rather than excluded silently, so a SIXTH one is a finding.
  const DECLARED_RESYNC = [
    'packages/server/src/healer/healer-agent.ts',
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
