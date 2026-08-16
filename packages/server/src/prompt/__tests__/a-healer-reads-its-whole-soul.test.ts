// UX-REPAIR ROUND 12 / T59 — THE HEALER READS ITS WHOLE SOUL.
//
// ── STEP-0, MEASURED AT `85537ff` ON THE OWNER'S BOX, THROUGH THE LIVE SURFACE ──
//
//   GET /api/agents/healer/system-prompt   →   0 bytes
//   templates/HEALER-SOUL.md               →   10,948 bytes
//
// `agents.charter` is NULL for the Healer, so `readStoredCharter` falls to its legacy sniff.
// All **30** of its surviving `role='system'` rows are engine markers — 15 `[working-note]`,
// 4 `[Agent ended turn without replying…]`, 3 `[System:`, 8 `── Memory Compacted …` — because
// the soul row `healer/healer-agent.ts` wrote once at creation was pruned away. T57 taught the
// sniff to refuse the working notes, correctly; there was simply no identity left behind them.
// So the Healer ran on the synthesized sub-agent stub ("You are **Healer**, a sensei agent…"),
// and its diagnostic runbook, database schema, evidence discipline and never-do list reached
// no model on any box.
//
// ── THE RULES THIS FILE IS — W24's and W25's, applied one agent over ──
// 1. The Healer's runtime identity IS the shipped template.
// 2. The card shows exactly what the runtime reads (T40's one-store property).
// 3. A stored soul still carrying `{{…}}` is an engine-written default and is re-seeded; an
//    OWNER-EDITED soul is never overwritten.
// 4. The in-code stub is the last resort only, and it says so out loud when it engages.
// 5. THE DEAD READER IS GONE, not left beside the live one.
// 6. T57's guard is NOT removed: it is the backstop for every agent still on the charter path,
//    and the Healer's own note-cannot-be-an-identity property now holds twice over.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const HOME_DIR_NAME = 'dojo-w42-healer-soul';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-w42-healer-soul');
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
import { insertMessage } from '../../memory/message-store.js';
import { getSoulContent, soulFileForAgent, healerSoulDefaultFrom } from '../assembler.js';
import { readAgentPromptSurface, writeAgentPromptSurface } from '../agent-prompt-surface.js';
import { WORKING_NOTE_PREFIX } from '@dojo/shared';

const HOME = path.join(realOs.tmpdir(), HOME_DIR_NAME);
const PROMPTS = path.join(HOME, '.dojo', 'prompts');
const HEALER = 'healer';
const PRIMARY = 'kevin';

const SHIPPED = fs.readFileSync(
  path.resolve(__dirname, '../../../../../templates/HEALER-SOUL.md'),
  'utf-8',
);

// The 88-byte row that stood in as the Healer's whole identity before T57 (W25 §4c).
const THE_88_BYTE_NOTE =
  `${WORKING_NOTE_PREFIX}Two issues to address: the scheduler backlog and the stale model row.`;

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
  setConfig('primary_agent_name', 'Kevin');
  setConfig('healer_agent_id', HEALER);
  setConfig('healer_agent_name', 'Healer');
  setConfig('owner_name', 'David');
  const platform = await import('../../config/platform.js');
  platform.clearPlatformConfigCache();
  mockDb.current
    .prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')")
    .run(HEALER, 'Healer');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('the Healer runs on its whole soul', () => {
  it('THE MEASURED DEFECT: the runtime identity is the 10,948-byte shipped doctrine, not a synthesized stub', () => {
    const soul = getSoulContent(HEALER);

    expect(soul.length).toBeGreaterThan(10_000);
    // The synthesized sub-agent identity is what it served at HEAD. It is gone.
    expect(soul).not.toContain('You are **Healer**');
    // Sections that reached no model at all before this task.
    expect(soul).toContain('# Diagnostic Runbook');
    expect(soul).toContain('# Database Schema');
    expect(soul).toContain('# Evidence Discipline');
    expect(soul).toContain('# Core Philosophy');
    expect(soul).toContain('# Where Things Live');
    expect(soul).toContain('# What You Never Do');
  });

  it('the doctrine the platform depends on arrives intact — the affordable-model rule and the runbook', () => {
    const soul = getSoulContent(HEALER);

    // The rule `healer/diagnostic.ts:575` already cites as binding on the Healer.
    expect(soul).toContain('"switch to a better model" is not a solution');
    expect(soul).not.toContain('{{');
    expect(soul).toBe(SHIPPED);
  });

  it('T40 HOLDS: the settings card shows exactly what the runtime reads', () => {
    expect(readAgentPromptSurface(HEALER)).toBe(getSoulContent(HEALER));
  });

  it('an owner edit through the card still reaches the model, and is never re-seeded away', () => {
    const owned = '# Identity\n\nYou are the Healer and you fix one thing at a time. That is all.';
    writeAgentPromptSurface(HEALER, owned);

    expect(getSoulContent(HEALER)).toBe(owned);
    // Read twice: a re-seed that fired on any read would clobber the owner's words.
    expect(getSoulContent(HEALER)).toBe(owned);
    expect(readAgentPromptSurface(HEALER)).toBe(owned);
  });

  it('the soul file is declared with the re-seed clause, and it is NOT the primary — no spawn truth pass', () => {
    const soul = soulFileForAgent(HEALER);

    expect(soul?.file).toBe('HEALER-SOUL.md');
    expect(soul?.reseedUnsubstituted).toBe(true);
    expect(soul?.spawnTruth).toBe(false);
    expect(soul!.fallback).toBe(SHIPPED);
  });

  it('THE WORN-IN BOX: a stored soul still carrying `{{…}}` is re-seeded from the shipped template', () => {
    // HEALER-SOUL.md carries no placeholder today, so this clause can only fire on a file seeded
    // from some OTHER version of the doctrine. Declared and asserted anyway: the flag is about
    // what a stored file may contain, not about what today's template happens to contain.
    fs.writeFileSync(
      path.join(PROMPTS, 'HEALER-SOUL.md'),
      '# Identity\n\nYou are the healer. Escalate to {{primary_agent_name}}.\n',
      'utf-8',
    );

    const soul = getSoulContent(HEALER);

    expect(soul).toBe(SHIPPED);
    expect(soul).not.toContain('{{');
    expect(fs.readFileSync(path.join(PROMPTS, 'HEALER-SOUL.md'), 'utf-8')).toBe(soul);
  });

  it('the last-resort stub engages only when NO templates directory exists, and it is not silent', () => {
    const logs: string[] = [];

    const soul = healerSoulDefaultFrom(() => null, (msg) => logs.push(msg));

    expect(soul).not.toContain('{{');
    expect(soul).toContain('You are the Healer');
    expect(soul).toContain('[INJURY ALERT]');
    expect(logs.join(' ')).toMatch(/HEALER-SOUL\.md/);
  });
});

describe('T57 STILL HOLDS, and now it holds twice', () => {
  it("the 88-byte working note can never be the Healer's identity — now because the file outranks the whole charter path", () => {
    insertMessage({ id: 'n1', agentId: HEALER, role: 'system', content: THE_88_BYTE_NOTE });

    const soul = getSoulContent(HEALER);
    expect(soul).not.toContain('Two issues to address');
    expect(soul).not.toContain('working-note');
    expect(soul).toBe(SHIPPED);
    expect(readAgentPromptSurface(HEALER)).toBe(SHIPPED);
  });

  it('CONTROL: the note is REFUSED, never deleted — T59 is a resolution change, not a sweep', () => {
    insertMessage({ id: 'n1', agentId: HEALER, role: 'system', content: THE_88_BYTE_NOTE });
    getSoulContent(HEALER);
    readAgentPromptSurface(HEALER);

    const row = mockDb.current!
      .prepare('SELECT content FROM messages WHERE id = ?').get('n1') as { content: string };
    expect(row.content).toBe(THE_88_BYTE_NOTE);
  });

  it('CONTROL: a real soul ROW is also no longer consulted — the file is the store, and only the file', () => {
    // The pre-T59 shape: the row healer-agent.ts used to write. It must not resurface as the
    // identity now that a file exists, or there would be two stores again.
    insertMessage({
      id: 's1', agentId: HEALER, role: 'system',
      content: '# Identity\n\nAn old soul row from an earlier boot.',
    });

    expect(getSoulContent(HEALER)).toBe(SHIPPED);
  });
});

describe('the dead second reader is gone, not left beside the live one', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../../healer/healer-agent.ts'), 'utf-8');

  it('healer-agent.ts no longer reads the template or writes a soul row', () => {
    expect(SRC).not.toMatch(/function loadHealerSoulPrompt/);
    expect(SRC).not.toMatch(/loadHealerSoulPrompt\(\)/);
    expect(SRC).not.toMatch(/HEALER-SOUL\.md'\)/);
    expect(SRC).not.toMatch(/insertMessageIfAbsent\(\{[^}]*role: 'system'/);
  });

  it('the tombstone names where the requirement now lives', () => {
    expect(SRC).toContain('W42 TOMBSTONE');
    expect(SRC).toContain('prompt/assembler.ts');
  });
});

describe('CONTROLS — the souls that were already right do not move', () => {
  it('the shipped Healer template names no placeholder the ONE substituter does not know', async () => {
    const { PLATFORM_SOUL_PLACEHOLDERS } = await import('../assembler.js');
    const used = new Set([...SHIPPED.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]));
    for (const p of used) {
      expect((PLATFORM_SOUL_PLACEHOLDERS as readonly string[]).includes(p), `{{${p}}}`).toBe(true);
    }
  });

  it('the PRIMARY is untouched — SOUL.md, spawn truth ON, no re-seed clause (owner ruling #2)', () => {
    const soul = soulFileForAgent(PRIMARY);
    expect(soul?.file).toBe('SOUL.md');
    expect(soul?.spawnTruth).toBe(true);
    expect(soul?.reseedUnsubstituted).toBeUndefined();
  });

  it('an ordinary sub-agent still has NO soul file, so T57s charter path is still the one it uses', () => {
    mockDb.current!.prepare("INSERT INTO agents (id, name, status) VALUES ('w1', 'Worker', 'idle')").run();
    expect(soulFileForAgent('w1')).toBeNull();

    insertMessage({ id: 'n1', agentId: 'w1', role: 'system', content: THE_88_BYTE_NOTE });
    const soul = getSoulContent('w1');
    expect(soul).not.toContain('Two issues to address');
    expect(soul).toContain('You are **Worker**');
  });
});
