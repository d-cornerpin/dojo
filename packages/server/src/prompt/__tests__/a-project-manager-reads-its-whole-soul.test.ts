// HARNESS-LEARNINGS SITTING 0 / W24 — THE PROJECT MANAGER READS ITS WHOLE SOUL.
//
// ── WHAT WAS MEASURED (live, at `07434e0`, on a driven validation review) ──
// The PM's system prompt at the `callModel` boundary was 22,491 bytes, and the identity
// block inside it was this, verbatim:
//     # {{pm_agent_name}} — Project Manager
//     You are {{pm_agent_name}}, the project manager for the DOJO Agent Platform…
// 961 bytes, with the template placeholders never substituted, on four consecutive model
// calls. `templates/PM-SOUL.md` — 13,593 bytes of actual doctrine: the skepticism block, the
// dereference-before-rejecting rule, the issue-type→verb table, the non-idempotent duplicate
// trap — reached NO model, on any box.
//
// ── THE SEAM, PINNED ──
// `sys.identity` (`prompt/registry/entries.ts:70`) renders `getSoulContent()` (`:159`), which
// resolves through `soulFileForAgent` (`:108`) to `~/.dojo/prompts/PM-SOUL.md` with
// `DEFAULT_PM_SOUL_MD` — the in-code stub — as the seed written on first read. Nothing on that
// path ever reads `templates/PM-SOUL.md`, and nothing on it substitutes a `{{…}}`.
//
// `tracker/pm-agent.ts` DID read the template and DID substitute it — and wrote the result to
// a `role='system'` row in `messages`. The message assembler's `tailRender`
// (`memory/assembler.ts:1174-1189`) emits only `user`/`assistant`/`tool` rows, so that row
// could not reach a model. Two readers of one file name, and the one that did the work fed a
// store the model cannot see.
//
// ── THE RULE THIS FILE IS ──
// 1. The PM's runtime identity IS the shipped template, substituted, with no placeholder left.
// 2. The card still shows exactly what the runtime reads (T40's one-store property).
// 3. A stored soul that still carries `{{…}}` is an engine-written default, not an authored
//    identity: it is re-seeded. An OWNER-EDITED soul is never overwritten.
// 4. The in-code stub is the last resort only, and it says so out loud when it engages.
// 5. The doctrine may not name a tool the PM cannot call. That is what rotted here unseen:
//    the template still spoke the retired `tracker_*` vocabulary the verb collapse replaced.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const HOME_DIR_NAME = 'dojo-w24-pm-soul';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-w24-pm-soul');
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
import { getSoulContent, soulFileForAgent, readSoulFile, writeSoulFile } from '../assembler.js';
import { readAgentPromptSurface, writeAgentPromptSurface } from '../agent-prompt-surface.js';
import { PM_ALLOWED_WORK_OPS } from '../../tracker/pm-agent.js';
import { WORK_OPS } from '../../tools/work-verbs.js';

const HOME = path.join(realOs.tmpdir(), HOME_DIR_NAME);
const PROMPTS = path.join(HOME, '.dojo', 'prompts');
const PM = 'kelly';
const PRIMARY = 'kevin';

/** The shipped template, read from the repo the way the runtime resolves it. */
const SHIPPED = fs.readFileSync(
  path.resolve(__dirname, '../../../../../templates/PM-SOUL.md'),
  'utf-8',
);

function setConfig(key: string, value: string): void {
  mockDb.current!
    .prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

beforeEach(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(PROMPTS, { recursive: true });
  mockDb.current = new Database(':memory:');
  runMigrations();
  setConfig('primary_agent_id', PRIMARY);
  setConfig('primary_agent_name', 'Kevin');
  setConfig('pm_agent_id', PM);
  setConfig('pm_agent_name', 'Kelly');
  setConfig('owner_name', 'David');
  const platform = await import('../../config/platform.js');
  platform.clearPlatformConfigCache();
  mockDb.current
    .prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')")
    .run(PM, 'Kelly');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('the PM runs on its whole soul', () => {
  it('THE MEASURED DEFECT: the runtime identity is the full shipped doctrine, not the 961-byte stub', () => {
    const soul = getSoulContent(PM);

    // The doctrine the stub does not have. Each of these is a section of `templates/PM-SOUL.md`
    // whose absence was a live behaviour: the skepticism block is the one that tells the PM to
    // dereference a pointer before it rejects a close.
    expect(soul).toContain('# Skepticism');
    expect(soul).toContain('NEVER reject because you didn');
    expect(soul).toContain('# Non-idempotent tasks, the duplicate-action trap');
    expect(soul).toContain('# Vault, Review Continuity');
    expect(soul.length).toBeGreaterThan(10_000);
  });

  it('every placeholder is substituted — the model is never shown a `{{…}}`', () => {
    const soul = getSoulContent(PM);

    expect(soul).not.toContain('{{');
    expect(soul).toContain('You are Kelly,');
    expect(soul).toContain('Kevin');
    expect(soul).toContain('David');
  });

  it('T40 HOLDS: the settings card shows exactly what the runtime reads', () => {
    expect(readAgentPromptSurface(PM)).toBe(getSoulContent(PM));
  });

  it('an owner edit through the card still reaches the model, and is never re-seeded away', () => {
    writeAgentPromptSurface(PM, '# Identity\n\nYou are Kelly and you validate closes. That is all.');

    expect(getSoulContent(PM)).toBe('# Identity\n\nYou are Kelly and you validate closes. That is all.');
    // Read twice: a re-seed that fired on any read would clobber the owner's words.
    expect(getSoulContent(PM)).toBe('# Identity\n\nYou are Kelly and you validate closes. That is all.');
    expect(readAgentPromptSurface(PM)).toBe(getSoulContent(PM));
  });

  it('THE WORN-IN BOX: a stored soul still carrying `{{…}}` is an engine default and is re-seeded', () => {
    // Exactly what sits on the owner's box: the June stub, written by `readPromptFile` and
    // never substituted by anything.
    const stub = '# {{pm_agent_name}} — Project Manager\n\nYou are {{pm_agent_name}}, the project manager.\n';
    fs.writeFileSync(path.join(PROMPTS, 'PM-SOUL.md'), stub, 'utf-8');

    const soul = getSoulContent(PM);

    expect(soul).toContain('# Skepticism');
    expect(soul).not.toContain('{{');
    // Re-seeded on disk, so the card and the model agree from here on.
    expect(fs.readFileSync(path.join(PROMPTS, 'PM-SOUL.md'), 'utf-8')).toBe(soul);
    expect(readAgentPromptSurface(PM)).toBe(soul);
  });

  it('the last-resort stub is substituted too, and it is not silent', async () => {
    const { pmSoulDefaultFrom } = await import('../assembler.js');
    const logs: string[] = [];

    const soul = pmSoulDefaultFrom(() => null, (msg) => logs.push(msg));

    expect(soul).not.toContain('{{');
    expect(soul).toContain('Kelly');
    expect(logs.join(' ')).toMatch(/PM-SOUL\.md/);
  });

  it('the shipped template resolves in the packaged layout as well as the repo', async () => {
    const { platformTemplateSearchPaths } = await import('../assembler.js');
    const paths = platformTemplateSearchPaths('PM-SOUL.md');

    // The repo layout (`<root>/templates`) and the installed layout
    // (`~/.dojo/platform/templates`, per deploy/build-package.sh:70 + install.sh:11-12).
    expect(paths.some((p) => p.endsWith(path.join('templates', 'PM-SOUL.md')))).toBe(true);
    expect(paths.some((p) => p.includes(path.join('.dojo', 'platform', 'templates')))).toBe(true);
    expect(paths.some((p) => fs.existsSync(p))).toBe(true);
  });
});

describe('the doctrine may not name a door that does not exist', () => {
  it('no retired `tracker_*` verb survives in the PM soul', () => {
    const retired = [...SHIPPED.matchAll(/\btracker_[a-z_]+/g)].map((m) => m[0]);
    expect(retired).toEqual([]);
  });

  it('every work verb the soul names is one the PM is actually allowed to call', () => {
    const verbs = new Set([...SHIPPED.matchAll(/\b(work_[a-z_]+)\s*\(/g)].map((m) => m[1]));
    const allowed = new Set(PM_ALLOWED_WORK_OPS.map((op) => op.split(':')[0]));
    for (const v of verbs) expect(allowed.has(v), `${v} is named by PM-SOUL.md`).toBe(true);
  });

  it('the soul never instructs an operation the PM overseer gate refuses', () => {
    // `work_update:status` is deliberately ABSENT from `PM_ALLOWED_WORK_OPS` — the PM
    // adjudicates, it does not flip a worker's status. Doctrine that orders it produces a
    // refused call and a confused validator.
    expect(WORK_OPS).toContain('work_update:status');
    expect(PM_ALLOWED_WORK_OPS).not.toContain('work_update:status');
    expect(SHIPPED).not.toMatch(/work_update\s*\(\s*action\s*=\s*["']status["']/);
  });

  it('the corrections the shipped stub carried are not lost in the restoration', () => {
    // The stub is the text that has actually been reaching the model, and it had been fixed in
    // two places the template never got: the ASSIGN intent, and the restart rule.
    expect(SHIPPED).toContain('intent="ASSIGN"');
    expect(SHIPPED).toMatch(/resumes itself from the work record/);
    expect(SHIPPED).not.toContain('poke_log');
  });
});
