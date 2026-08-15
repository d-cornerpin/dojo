// HARNESS-LEARNINGS SITTING 1 / W25 — THE TRAINER READS ITS WHOLE SOUL.
//
// W24 fixed this exact defect for the project manager and handed the Trainer up as the same
// shape. Re-verified at `80fa123` before a line was written, on the dev box:
//
//   ~/.dojo/prompts/TRAINER-SOUL.md   3,023 bytes, dated Jun 1, and its first line reads
//                                     "You are {{trainer_agent_name}}, the technique trainer"
//   templates/TRAINER-SOUL.md         8,074 bytes of actual craft
//
// The stored file is what `getSoulContent` serves, so a literal `{{trainer_agent_name}}` was
// reaching the model and five kilobytes of doctrine were reaching nobody. `readPromptFile`
// seeds only when the file is ABSENT, so every later correction to the in-code stub — itself
// now larger than the stored file — never reached a box that had booted once.
//
// `techniques/trainer-agent.ts:19-58` held the SECOND reader: it read the template,
// substituted all three names correctly, and wrote the result as a `role='system'` message
// row that `tailRender` does not emit. Dead on arrival, twice over, like the PM's.
//
// THE RULES THIS FILE IS, and they are W24's, applied one agent over:
// 1. The Trainer's runtime identity IS the shipped template, substituted, no placeholder left.
// 2. The card shows exactly what the runtime reads (T40's one-store property).
// 3. A stored soul still carrying `{{…}}` is an engine-written default and is re-seeded; an
//    OWNER-EDITED soul is never overwritten.
// 4. The in-code stub is the last resort only, and it says so out loud when it engages.
// 5. THE DEAD READER IS GONE, not left beside the live one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const HOME_DIR_NAME = 'dojo-w25-trainer-soul';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-w25-trainer-soul');
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
import { getSoulContent, soulFileForAgent, trainerSoulDefaultFrom } from '../assembler.js';
import { readAgentPromptSurface, writeAgentPromptSurface } from '../agent-prompt-surface.js';

const HOME = path.join(realOs.tmpdir(), HOME_DIR_NAME);
const PROMPTS = path.join(HOME, '.dojo', 'prompts');
const TRAINER = 'ticky';
const PRIMARY = 'kevin';

const SHIPPED = fs.readFileSync(
  path.resolve(__dirname, '../../../../../templates/TRAINER-SOUL.md'),
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
  setConfig('trainer_agent_id', TRAINER);
  setConfig('trainer_agent_name', 'Ticky');
  setConfig('owner_name', 'David');
  const platform = await import('../../config/platform.js');
  platform.clearPlatformConfigCache();
  mockDb.current
    .prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')")
    .run(TRAINER, 'Ticky');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('the Trainer runs on its whole soul', () => {
  it('THE MEASURED DEFECT: the runtime identity is the full shipped craft, not the 3,023-byte stub', () => {
    const soul = getSoulContent(TRAINER);

    expect(soul.length).toBeGreaterThan(7_000);
    // Sections the stored stub does not have at all — the ownership rule, the save-time
    // reference check, the dependency manifest, the import protocol, the vault rule.
    expect(soul).toContain('# You Are the Sole Owner of Techniques');
    expect(soul).toContain('# File-Reference Integrity (Enforced at Save)');
    expect(soul).toContain('# Dependency Manifest');
    expect(soul).toContain('# Importing a Technique');
    expect(soul).toContain('# Vault — Technique Wisdom');
  });

  it('every placeholder is substituted — the model is never shown a `{{…}}`', () => {
    const soul = getSoulContent(TRAINER);

    expect(soul).not.toContain('{{');
    expect(soul).toContain('You are Ticky,');
  });

  it('T40 HOLDS: the settings card shows exactly what the runtime reads', () => {
    expect(readAgentPromptSurface(TRAINER)).toBe(getSoulContent(TRAINER));
  });

  it('an owner edit through the card still reaches the model, and is never re-seeded away', () => {
    const owned = '# Identity\n\nYou are Ticky and you write techniques. That is all.';
    writeAgentPromptSurface(TRAINER, owned);

    expect(getSoulContent(TRAINER)).toBe(owned);
    // Read twice: a re-seed that fired on any read would clobber the owner's words.
    expect(getSoulContent(TRAINER)).toBe(owned);
    expect(readAgentPromptSurface(TRAINER)).toBe(owned);
  });

  it('THE WORN-IN BOX: the exact 3,023-byte stored stub is re-seeded, placeholder and all', () => {
    // The first three lines of the file that is actually on the owner's disk.
    const stub = '# Identity\n\nYou are {{trainer_agent_name}}, the technique trainer for the DOJO Agent Platform.\n';
    fs.writeFileSync(path.join(PROMPTS, 'TRAINER-SOUL.md'), stub, 'utf-8');

    const soul = getSoulContent(TRAINER);

    expect(soul).toContain('# You Are the Sole Owner of Techniques');
    expect(soul).not.toContain('{{');
    expect(fs.readFileSync(path.join(PROMPTS, 'TRAINER-SOUL.md'), 'utf-8')).toBe(soul);
    expect(readAgentPromptSurface(TRAINER)).toBe(soul);
  });

  it('the soul file is declared with the re-seed clause — the half that reaches a worn-in box', () => {
    const soul = soulFileForAgent(TRAINER);
    expect(soul?.file).toBe('TRAINER-SOUL.md');
    expect(soul?.reseedUnsubstituted).toBe(true);
    expect(soul?.spawnTruth).toBe(false);
    // The declared fallback is the SHIPPED template, substituted — not the in-code stub.
    expect(soul!.fallback).toContain('# You Are the Sole Owner of Techniques');
    expect(soul!.fallback).not.toContain('{{');
  });

  it('the last-resort stub is substituted too, and it is not silent', () => {
    const logs: string[] = [];

    const soul = trainerSoulDefaultFrom(() => null, (msg) => logs.push(msg));

    expect(soul).not.toContain('{{');
    expect(soul).toContain('Ticky');
    expect(logs.join(' ')).toMatch(/TRAINER-SOUL\.md/);
  });
});

describe('the dead second reader is gone, not left beside the live one', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../../techniques/trainer-agent.ts'), 'utf-8');

  it('trainer-agent.ts no longer reads a template or writes a soul row', () => {
    // The function and the call, not the WORD — the tombstone names both on purpose.
    expect(SRC).not.toMatch(/function loadTrainerSoulPrompt/);
    expect(SRC).not.toMatch(/loadTrainerSoulPrompt\(\)/);
    // The write itself: a `role='system'` row nothing in the assembly path emits.
    expect(SRC).not.toMatch(/insertMessageIfAbsent\s*\(/);
    // …and it does not touch the filesystem at all any more.
    expect(SRC).not.toMatch(/from 'node:fs'/);
    expect(SRC).not.toMatch(/readFileSync/);
  });

  it('the tombstone names where the requirement now lives', () => {
    expect(SRC).toContain('W25 TOMBSTONE');
    expect(SRC).toContain('prompt/assembler.ts');
  });
});

describe('the doctrine may not name a door that does not exist', () => {
  it('no retired `tracker_*` verb survives in the Trainer soul', () => {
    expect([...SHIPPED.matchAll(/\btracker_[a-z_]+/g)].map((m) => m[0])).toEqual([]);
  });

  it('the only placeholder the template uses is one the substituter knows', () => {
    const used = new Set([...SHIPPED.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]));
    for (const p of used) {
      expect(['trainer_agent_name', 'primary_agent_name', 'owner_name'].includes(p), `{{${p}}}`).toBe(true);
    }
  });
});
