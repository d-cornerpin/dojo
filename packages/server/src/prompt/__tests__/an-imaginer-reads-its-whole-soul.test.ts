// UX-REPAIR ROUND 12 / T59 — THE IMAGINER READS ITS WHOLE SOUL.
//
// ── STEP-0, MEASURED AT `85537ff` ON THE OWNER'S BOX, THROUGH THE LIVE SURFACE ──
//
//   GET /api/agents/imaginer/system-prompt   →   0 bytes
//   SELECT COUNT(*) … role='system'          →   0 rows
//   templates/IMAGINER-SOUL.md               →   2,737 bytes
//
// The Imaginer is the cleanest instance of the class in the tree. `imaginer-agent.ts` wrote its
// soul as a `role='system'` row at agent CREATION only, and this box's Imaginer predates that
// write — so there was no row at all, `readStoredCharter` returned '', and the model ran on the
// synthesized sub-agent identity. The one document that explains that `image_create` is handled
// by the ENGINE and that its own LLM does not run for those requests reached nobody, which is
// exactly the confusion its "don't try to deliver anything" rules exist to prevent.
//
// ── THE RULES THIS FILE IS ──
// 1. The Imaginer's runtime identity IS the shipped template, substituted, no placeholder left.
// 2. The card shows exactly what the runtime reads (T40's one-store property).
// 3. `{{imaginer_agent_name}}` is filled by the ONE substituter — the second one is deleted.
// 4. A stored soul carrying `{{…}}` is re-seeded; an OWNER-EDITED soul is never overwritten.
// 5. The in-code stub is the last resort only, it is substituted too, and it is loud.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const HOME_DIR_NAME = 'dojo-w42-imaginer-soul';

// The platform resolves `~/.dojo` in exactly one place — `src/home.ts` — so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-w42-imaginer-soul');
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
import { getSoulContent, soulFileForAgent, imaginerSoulDefaultFrom } from '../assembler.js';
import { readAgentPromptSurface, writeAgentPromptSurface } from '../agent-prompt-surface.js';
import { PLATFORM_SOUL_PLACEHOLDERS } from '../assembler.js';
import * as platform from '../../config/platform.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const HOME = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), HOME_DIR_NAME);
const PROMPTS = path.join(HOME, '.dojo', 'prompts');
const IMAGINER = 'imaginer';
const PRIMARY = FXID.n4;

const SHIPPED = fs.readFileSync(
  path.resolve(__dirname, '../../../../../templates/IMAGINER-SOUL.md'),
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
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  mockDb.current = new Database(':memory:');
  runMigrations();
  setConfig('primary_agent_id', PRIMARY);
  setConfig('primary_agent_name', FX.n4);
  setConfig('imaginer_agent_id', IMAGINER);
  setConfig('imaginer_agent_name', 'Iris');
  setConfig('owner_name', FX.n11);
  platform.clearPlatformConfigCache();
  mockDb.current
    .prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')")
    .run(IMAGINER, 'Iris');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('the Imaginer runs on its whole soul', () => {
  it('THE MEASURED DEFECT: the runtime identity is the shipped doctrine, not the synthesized sub-agent stub', () => {
    const soul = getSoulContent(IMAGINER);

    expect(soul.length).toBeGreaterThan(2_500);
    expect(soul).not.toContain('You are **Iris**');
    // The three sections that reached no model: how the flow really runs, when the LLM runs, the rules.
    expect(soul).toContain('# How Image Generation Actually Works');
    expect(soul).toContain('# When Your LLM Actually Runs');
    expect(soul).toContain('**Your LLM does not run for those requests.**');
    expect(soul).toContain('Never call `imessage_send`');
  });

  it('THE ONE SUBSTITUTER fills `{{imaginer_agent_name}}` — the second one is gone, not shadowed', () => {
    const soul = getSoulContent(IMAGINER);

    expect(soul).not.toContain('{{');
    expect(soul).toContain('You are Iris, the dojo\'s image generation specialist');
    // The other two names the template uses come from the same door.
    expect(soul).toContain(FX.n4);
    expect(soul).toContain(FX.n11);
    expect(soul).toBe(
      SHIPPED
        .replace(/\{\{imaginer_agent_name\}\}/g, 'Iris')
        .replace(/\{\{primary_agent_name\}\}/g, FX.n4)
        .replace(/\{\{owner_name\}\}/g, FX.n11),
    );
  });

  it('T40 HOLDS: the settings card shows exactly what the runtime reads', () => {
    expect(readAgentPromptSurface(IMAGINER)).toBe(getSoulContent(IMAGINER));
  });

  it('an owner edit through the card still reaches the model, and is never re-seeded away', () => {
    const owned = '# Identity\n\nYou are Iris. You make pictures and you say little.';
    writeAgentPromptSurface(IMAGINER, owned);

    expect(getSoulContent(IMAGINER)).toBe(owned);
    expect(getSoulContent(IMAGINER)).toBe(owned);
    expect(readAgentPromptSurface(IMAGINER)).toBe(owned);
  });

  it('the soul file is declared with the re-seed clause, and it is NOT the primary — no spawn truth pass', () => {
    const soul = soulFileForAgent(IMAGINER);

    expect(soul?.file).toBe('IMAGINER-SOUL.md');
    expect(soul?.reseedUnsubstituted).toBe(true);
    expect(soul?.spawnTruth).toBe(false);
    expect(soul!.fallback).toContain('# How Image Generation Actually Works');
    expect(soul!.fallback).not.toContain('{{');
  });

  it('THE WORN-IN BOX: a stored soul still carrying `{{imaginer_agent_name}}` is re-seeded', () => {
    fs.writeFileSync(
      path.join(PROMPTS, 'IMAGINER-SOUL.md'),
      '# Identity\n\nYou are {{imaginer_agent_name}}, the image agent.\n',
      'utf-8',
    );

    const soul = getSoulContent(IMAGINER);

    expect(soul).toContain('# How Image Generation Actually Works');
    expect(soul).not.toContain('{{');
    expect(fs.readFileSync(path.join(PROMPTS, 'IMAGINER-SOUL.md'), 'utf-8')).toBe(soul);
    expect(readAgentPromptSurface(IMAGINER)).toBe(soul);
  });

  it('the last-resort stub is substituted too, and it is not silent', () => {
    const logs: string[] = [];

    const soul = imaginerSoulDefaultFrom(() => null, (msg) => logs.push(msg));

    expect(soul).not.toContain('{{');
    expect(soul).toContain('You are Iris,');
    expect(logs.join(' ')).toMatch(/IMAGINER-SOUL\.md/);
  });
});

describe('CONTROLS — nothing that was already right moves', () => {
  it('the shipped Imaginer template names no placeholder the ONE substituter does not know', async () => {
    const used = new Set([...SHIPPED.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]));
    expect(used.has('imaginer_agent_name')).toBe(true);   // the one T59 had to add
    for (const p of used) {
      expect((PLATFORM_SOUL_PLACEHOLDERS as readonly string[]).includes(p), `{{${p}}}`).toBe(true);
    }
  });

  it('EVERY shipped soul template is answerable by the one substituter — the durable guard', async () => {
    const dir = path.resolve(__dirname, '../../../../../templates');
    const souls = fs.readdirSync(dir).filter((f) => f.endsWith('-SOUL.md')).sort();
    expect(souls.length).toBeGreaterThanOrEqual(5);
    for (const file of souls) {
      const body = fs.readFileSync(path.join(dir, file), 'utf-8');
      for (const m of body.matchAll(/\{\{([a-z_]+)\}\}/g)) {
        expect(
          (PLATFORM_SOUL_PLACEHOLDERS as readonly string[]).includes(m[1]),
          `${file} uses {{${m[1]}}}, which substitutePlatformNames does not fill`,
        ).toBe(true);
      }
    }
  });

  it('the PRIMARY is untouched — SOUL.md, spawn truth ON, no re-seed clause (owner ruling #2)', () => {
    const soul = soulFileForAgent(PRIMARY);
    expect(soul?.file).toBe('SOUL.md');
    expect(soul?.spawnTruth).toBe(true);
    expect(soul?.reseedUnsubstituted).toBeUndefined();
  });

  it('THE DREAMER IS NOT FILE-BACKED — the recorded Step-0 stand-down, pinned so it cannot drift in', () => {
    // Its template reaches its model already (18,762 B served live at `85537ff`, byte-identical
    // to templates/DREAMER-SOUL.md, refreshed from the template on every boot by
    // vault/maintenance.ts). The T59 ruling covers it only if Step-0 proves otherwise.
    setConfig('dreamer_agent_id', 'dreamer');
    mockDb.current!.prepare("INSERT INTO agents (id, name, status) VALUES ('dreamer', 'Dreamer', 'idle')").run();
    expect(soulFileForAgent('dreamer')).toBeNull();
  });
});
