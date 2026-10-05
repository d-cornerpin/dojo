// ════════════════════════════════════════════════════════════════════════════════════════
// AN AGENT READS ITS OWN NAME — `{{agent_name}}` IS NEVER A LITERAL ON A MODEL'S SCREEN.
// (t103 item A — OWNER RULING 2026-10-05, verbatim: "the dojo should always replace that
//  variable with the actual agent's name.")
//
// ── WHAT WAS MEASURED AT `09514572`, BEFORE ANY CODE ──────────────────────────────────
// Six placeholders ship in the prompt vocabulary. `substitutePlatformNames` filled five of
// them; `agent_name` — the one in `DEFAULT_SOUL_MD` and `templates/SOUL.md`, i.e. the PRIMARY
// agent's own identity — was filled by nothing. It was also absent from `UNSUBSTITUTED`, so the
// W24 re-seed path could not notice it either. On any box whose `SOUL.md` was seeded by the
// engine rather than written by the OOBE identity form, the first two lines the primary agent
// read were `# {{agent_name}} — System Identity` and `You are {{agent_name}}, an AI agent …`.
//
// ── THE RULE THIS FILE IS ─────────────────────────────────────────────────────────────
//   §1  a soul carrying the token renders the agent's REAL name, on every branch that can
//       carry one (file-backed soul, in-code fallback, creator-written charter);
//   §2  a soul that does NOT carry it comes back BY IDENTITY — the cache property (G2). The
//       substituter may not move a prefix for an agent it has no business touching, and two
//       assemblies in a row are byte-identical either way;
//   §3  a RENAME is reflected on the next assembly, and NOT ONE BYTE on disk moves (the
//       ruling's "no edits to files on user boxes");
//   §4  the CLOSED VOCABULARY census — every `{{…}}` any shipped template declares is one this
//       module fills, and no shipped soul reaches a model with a `{{` left in it;
//   §5  the WIRE clause, both directions — there is exactly ONE soul door, the substitution is
//       applied at it, and a branch added inside the resolver is covered by construction.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

// Per-run AND per-worker scratch home, inside the run root — the convention
// `vitest.setup.ts` uses for every worker's home (seven worktrees share this box, and a fixed
// path under the system temp dir is how two workers delete each other's fixture mid-run).
const TEST_HOME_ROOT = process.env.DOJO_TEST_HOME_ROOT && process.env.DOJO_TEST_HOME_ROOT !== ''
  ? process.env.DOJO_TEST_HOME_ROOT
  : path.join(realOs.tmpdir(), 'dojo-test-homes', 'orphan-run');
const WORKER_ID = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 'x';
const HOME_DIR_NAME = `t103-agent-name-w${WORKER_ID}-${process.pid}`;

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const root = process.env.DOJO_TEST_HOME_ROOT && process.env.DOJO_TEST_HOME_ROOT !== ''
    ? process.env.DOJO_TEST_HOME_ROOT
    : p.join(o.tmpdir(), 'dojo-test-homes', 'orphan-run');
  const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 'x';
  const dir = p.join(root, `t103-agent-name-w${worker}-${process.pid}`);
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
import {
  getSoulContent, substituteAgentName, readSoulFile, soulFileForAgent,
  SOUL_PLACEHOLDERS, PLATFORM_SOUL_PLACEHOLDERS, AGENT_SOUL_PLACEHOLDER,
} from '../assembler.js';
import { renameAgent } from '../agent-rename.js';
import { DEFAULT_SOUL_MD } from '../templates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const ASSEMBLER_SRC = path.join(HERE, '..', 'assembler.ts');
const HOME = path.join(TEST_HOME_ROOT, HOME_DIR_NAME);
const PROMPTS = path.join(HOME, '.dojo', 'prompts');

// Ids and labels are fictional and shaped like roles, not like people (G1).
const PRIMARY = 'primary-one';
const PM = 'pm-one';
const TRAINER = 'trainer-one';
const HEALER = 'healer';
const IMAGINER = 'imaginer';
const SUB = 'sub-one';

const TOKEN = `{{${AGENT_SOUL_PLACEHOLDER}}}`;

const soulPath = (f: string): string => path.join(PROMPTS, f);

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

/** Source with line and block comments removed — G4: a clause satisfiable by the prose above
 *  a call is a clause about the prose. */
function strippedSource(file: string): string {
  return fs.readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

beforeEach(async () => {
  const { homeDir } = await import('../../home.js');
  if (homeDir() !== HOME) {
    throw new Error(`fixture drift: the home.js mock resolves ${homeDir()}, this test writes ${HOME}`);
  }
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(PROMPTS, { recursive: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  mockDb.current = new Database(':memory:');
  runMigrations();
  setConfig('primary_agent_id', PRIMARY);
  setConfig('primary_agent_name', 'Dojo Master');
  setConfig('pm_agent_id', PM);
  setConfig('pm_agent_name', 'Dojo Planner');
  setConfig('trainer_agent_id', TRAINER);
  setConfig('trainer_agent_name', 'Dojo Trainer');
  setConfig('healer_agent_id', HEALER);
  setConfig('healer_agent_name', 'Healer');
  setConfig('imaginer_agent_id', IMAGINER);
  setConfig('imaginer_agent_name', 'Imaginer');
  setConfig('owner_name', 'the owner');
  const platform = await import('../../config/platform.js');
  platform.clearPlatformConfigCache();
  seedAgent(PRIMARY, 'Dojo Master');
  seedAgent(PM, 'Dojo Planner');
  seedAgent(TRAINER, 'Dojo Trainer');
  seedAgent(HEALER, 'Healer');
  seedAgent(IMAGINER, 'Imaginer');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(HOME, { recursive: true, force: true });
});

// ════════════════════ §1 THE TOKEN BECOMES THE NAME ════════════════════

describe('§1 a soul carrying {{agent_name}} renders the agent\'s real name', () => {
  it('the ENGINE-SEEDED primary soul — the exact box the defect lived on', () => {
    // No SOUL.md on disk: `readSoulFile` seeds `DEFAULT_SOUL_MD`, which carries the token. This
    // is the worn-in box the measurement came from, reproduced from nothing.
    expect(DEFAULT_SOUL_MD).toContain(TOKEN);

    const rendered = getSoulContent(PRIMARY);
    expect(rendered).not.toContain(TOKEN);
    expect(rendered).toContain('# Dojo Master — System Identity');
    expect(rendered).toContain('You are Dojo Master, an AI agent running on the DOJO Agent Platform.');

    // The STORED bytes are untouched — the ruling's "no edits to files on user boxes". The
    // seeded file still carries the token; only the render fills it.
    const stored = readSoulFile(soulFileForAgent(PRIMARY)!);
    expect(stored).toContain(TOKEN);
  });

  it('an OWNER-AUTHORED soul that uses the token renders it too', () => {
    fs.writeFileSync(soulPath('SOUL.md'), `# ${TOKEN}\n\nYou are ${TOKEN}. Be brief.\n`, 'utf-8');
    expect(getSoulContent(PRIMARY)).toBe('# Dojo Master\n\nYou are Dojo Master. Be brief.\n');
  });

  it('EVERY occurrence, not just the first — the replace is global', () => {
    fs.writeFileSync(soulPath('SOUL.md'), `${TOKEN} ${TOKEN} ${TOKEN}\n`, 'utf-8');
    expect(getSoulContent(PRIMARY)).toBe('Dojo Master Dojo Master Dojo Master\n');
  });

  it('a per-agent soul FILE on a sub-agent — a different branch, same guarantee', () => {
    seedAgent(SUB, 'Scout');
    fs.writeFileSync(soulPath('SUB-ONE-SOUL.md'), `You are ${TOKEN}, a scout.\n`, 'utf-8');
    expect(getSoulContent(SUB)).toContain('You are Scout, a scout.');
    expect(getSoulContent(SUB)).not.toContain(TOKEN);
  });

  it('a CREATOR-WRITTEN CHARTER — "every agent" includes the one whose identity a person typed', () => {
    // The charter branch never passed through any substituter: a person typing the token into
    // the create form handed their agent the literal characters. The wrapper covers it because
    // it sits ABOVE every branch rather than inside one of them.
    seedAgent(SUB, 'Scout', `# Mission\n\nYou are ${TOKEN}. Review the queue.`);
    const rendered = getSoulContent(SUB);
    expect(rendered).toContain('You are Scout. Review the queue.');
    expect(rendered).not.toContain(TOKEN);
  });

  it('a renamed agent gets the NEW name, with no soul file rewritten', () => {
    // `renameAgent` deliberately skips `{{…}}`-carrying souls (its own rule). Before this item
    // that left the primary's seeded soul naming nobody at all, for ever.
    getSoulContent(PRIMARY);                                   // seeds SOUL.md from the default
    const before = fs.statSync(soulPath('SOUL.md')).mtimeMs;
    renameAgent(PRIMARY, 'Sensei');
    const rendered = getSoulContent(PRIMARY);
    expect(rendered).toContain('You are Sensei, an AI agent');
    expect(rendered).not.toContain('Dojo Master');
    expect(fs.statSync(soulPath('SOUL.md')).mtimeMs).toBe(before);
  });

  it('a nameless row falls back to a WORD, never to the token', () => {
    seedAgent(SUB, '');
    fs.writeFileSync(soulPath('SUB-ONE-SOUL.md'), `You are ${TOKEN}.\n`, 'utf-8');
    const rendered = getSoulContent(SUB);
    expect(rendered).not.toContain(TOKEN);
    expect(rendered).toContain('You are Agent.');
  });
});

// ════════════════════ §2 BY IDENTITY — THE CACHE PROPERTY (G2) ════════════════════

describe('§2 a soul without the token comes back BY IDENTITY, and the prefix holds still', () => {
  it('substituteAgentName returns its INPUT when there is nothing to fill', () => {
    const soul = '# Identity\n\nYou are the Healer. Be evidence-led.\n';
    const out = substituteAgentName(soul, HEALER);
    expect(Object.is(out, soul)).toBe(true);
  });

  it('an owner-authored soul renders byte-identically to its stored bytes', () => {
    const authored = '# Identity\n\nYou are the Dojo Master. Be brief.\n';
    fs.writeFileSync(soulPath('SOUL.md'), authored, 'utf-8');
    // (`spawnTruth` leaves an authored soul with no `## Capabilities` claims alone.)
    expect(getSoulContent(PRIMARY)).toBe(authored);
  });

  it('two assemblies in a row are byte-identical — with the token and without it', () => {
    fs.writeFileSync(soulPath('SOUL.md'), `You are ${TOKEN}.\n`, 'utf-8');
    expect(getSoulContent(PRIMARY)).toBe(getSoulContent(PRIMARY));
    fs.writeFileSync(soulPath('SOUL.md'), 'You are the Dojo Master.\n', 'utf-8');
    expect(getSoulContent(PRIMARY)).toBe(getSoulContent(PRIMARY));
  });

  it('a soul naming ANOTHER placeholder is not touched by this substituter', () => {
    // Only `agent_name` is this function's business. `{{pm_agent_name}}` belongs to the platform
    // substituter and the re-seed rule, and a one-token change that quietly widened to five
    // would move prefixes nobody argued for.
    const soul = 'Escalate to {{pm_agent_name}}.\n';
    expect(Object.is(substituteAgentName(soul, PRIMARY), soul)).toBe(true);
  });
});

// ════════════════════ §3 THE CLOSED VOCABULARY ════════════════════

describe('§3 the closed vocabulary — nothing ships a token this module cannot fill', () => {
  it('the vocabulary is the platform list PLUS the one per-agent name, and nothing else', () => {
    expect([...SOUL_PLACEHOLDERS].sort()).toEqual(
      [...PLATFORM_SOUL_PLACEHOLDERS, AGENT_SOUL_PLACEHOLDER].sort(),
    );
    expect(new Set(SOUL_PLACEHOLDERS).size).toBe(SOUL_PLACEHOLDERS.length);
  });

  it('EVERY `{{…}}` in every shipped template and in templates.ts is in the vocabulary', () => {
    // Both halves of the shipped surface: the files `templates/` installs, and the in-code
    // fallbacks `prompt/templates.ts` carries for a box with no templates directory. A seventh
    // placeholder written against either one REDS here instead of reaching a model.
    const templatesDir = path.join(REPO_ROOT, 'templates');
    const sources = fs.readdirSync(templatesDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(templatesDir, f));
    sources.push(path.join(HERE, '..', 'templates.ts'));
    expect(sources.length).toBeGreaterThan(5);

    const found = new Set<string>();
    for (const file of sources) {
      for (const m of fs.readFileSync(file, 'utf-8').matchAll(/\{\{([a-z_]+)\}\}/g)) {
        found.add(m[1]);
      }
    }
    expect(found.size).toBeGreaterThan(0);
    expect([...found].filter((t) => !(SOUL_PLACEHOLDERS as readonly string[]).includes(t)))
      .toEqual([]);
    // …and the other direction: the vocabulary is not carrying a name nothing uses any more.
    expect([...SOUL_PLACEHOLDERS].filter((t) => !found.has(t))).toEqual([]);
  });

  it('no soul the platform SEEDS FROM reaches a model with a `{{` left in it', () => {
    // The behavioural half of the census, driven through the real door for every file-backed
    // identity the platform ships. `{{` in a rendered prompt is the defect's own signature.
    for (const id of [PRIMARY, PM, TRAINER, HEALER, IMAGINER]) {
      const rendered = getSoulContent(id);
      expect(rendered.length, `${id} rendered nothing`).toBeGreaterThan(200);
      expect(rendered, `${id} still carries an unsubstituted placeholder`).not.toContain('{{');
    }
  });
});

// ════════════════════ §4 THE WIRE, BOTH DIRECTIONS ════════════════════

describe('§4 the wire — one soul door, and the substitution is applied at it', () => {
  const src = strippedSource(ASSEMBLER_SRC);

  it('getSoulContent APPLIES the substituter to the resolver\'s result', () => {
    // The call SHAPE and its APPLICATION (G4): the return value of the resolver is what is
    // substituted, and the result is what is returned. A clause that only asserted the
    // substituter is mentioned somewhere in this file would be satisfied by a dead import.
    expect(src).toMatch(
      /export function getSoulContent\(agentId: string\): string \{\s*return substituteAgentName\(resolveSoulContent\(agentId\), agentId\);\s*\}/,
    );
  });

  it('there is exactly ONE exported soul door, so no caller can bypass the substitution', () => {
    // The both-directions half. A second exported resolver — or exporting the inner one — is how
    // an unsubstituted soul would find its way out again, and this is what refuses it.
    const exported = [...src.matchAll(/export function (\w*[Ss]oulContent\w*)\s*\(/g)].map((m) => m[1]);
    expect(exported).toEqual(['getSoulContent']);
    expect(src).toMatch(/\nfunction resolveSoulContent\(agentId: string\): string \{/);
  });

  it('the substituter guards on the token before replacing — the identity return is CODE', () => {
    expect(src).toMatch(
      /export function substituteAgentName\(md: string, agentId: string\): string \{\s*if \(!md\.includes\(`\{\{\$\{AGENT_SOUL_PLACEHOLDER\}\}\}`\)\) return md;/,
    );
  });
});
