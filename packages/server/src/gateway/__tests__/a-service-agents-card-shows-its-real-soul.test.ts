// UX-REPAIR POST-.27 REPORT 2 / T40 — THE CARD SHOWS THE SOUL THE RUNTIME ACTUALLY READS.
//
// ── THE OWNER'S OBSERVATION ──
// On his box the PM's Settings card showed ONE line as the project manager's system prompt:
// `[Agent ended turn without replying — conversation closed]`. Nothing else.
//
// ── THE MECHANISM, AS MEASURED ──
// `GET /agents/:id/system-prompt` served, for every NON-primary agent,
//   `SELECT content FROM messages WHERE agent_id=? AND role='system' ORDER BY rowid ASC LIMIT 1`
// — first-system-row ARCHAEOLOGY. And the PM's own history is bounded: `prunePMMessages`
// keeps the newest 30 rows and `deleteForAgentBefore` deletes EVERYTHING older, system rows
// included. The engine writes `NO_REPLY_CLOSED_MARKER` as a `role='system'` row. So on any
// worn-in box the oldest SURVIVING system row can be that marker — and the card renders an
// engine marker as the agent's identity.
//
// ── THE DECISIVE HALF, PINNED (this is why this is a DISPLAY defect and not a lobotomy) ──
// The PM's RUNTIME system prompt does NOT come from message rows. `sys.identity`
// (`prompt/registry/entries.ts`) renders `getSoulContent()`, which for the PM reads
// `~/.dojo/prompts/PM-SOUL.md`; and `memory/assembler.ts`'s `tailRender` emits ONLY
// `user`/`assistant`/`tool` rows, so a `role='system'` row can never reach the model at all.
// The PM was never reviewing with a marker for a brain. The CARD was lying, and the card's
// EDIT box was writing to a row the runtime does not read — so an owner who "fixed" the
// prompt there changed nothing.
//
// ── WHAT THIS PINS ──
// One source of truth: the surface the card reads and writes IS the store the runtime reads.
// And no engine marker is ever presented as an identity, on any surface.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const HOME_DIR_NAME = 'dojo-t40-soul-surface';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-t40-soul-surface');
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
vi.mock('../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { getSoulContent } from '../../prompt/assembler.js';
import { readAgentPromptSurface, writeAgentPromptSurface } from '../../prompt/agent-prompt-surface.js';
import { NO_REPLY_CLOSED_MARKER } from '@dojo/shared';

const HOME = path.join(realOs.tmpdir(), HOME_DIR_NAME);
const PROMPTS = path.join(HOME, '.dojo', 'prompts');

const PRIMARY = 'kevin';
const PM = 'kelly';
const TRAINER = 'trainer';
const SUB = 'sub-agent-1';

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
  setConfig('trainer_agent_name', 'Trainer');
  setConfig('owner_name', 'David');
  // platform.ts caches config; re-read it against this database.
  const platform = await import('../../config/platform.js');
  platform.clearPlatformConfigCache();
  seedAgent(PRIMARY, 'Kevin');
  seedAgent(PM, 'Kelly');
  seedAgent(TRAINER, 'Trainer');
  seedAgent(SUB, 'Scout', 'You are Scout. Find things and report back.');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('the PM card reads the soul the runtime reads', () => {
  it('THE OWNERS BOX: the oldest surviving system row is an engine marker — and it is NOT what the card shows', () => {
    // The worn-in shape: the seeded soul row was pruned away; a marker is the oldest survivor.
    insertMessage({ id: 'm1', agentId: PM, role: 'system', content: NO_REPLY_CLOSED_MARKER });
    insertMessage({ id: 'm2', agentId: PM, role: 'system', content: '# Identity\n\nYou are Kelly…' });

    const shown = readAgentPromptSurface(PM);

    expect(shown).not.toBe(NO_REPLY_CLOSED_MARKER);
    expect(shown).not.toContain('ended turn without replying');
    // ONE SOURCE: what the card shows is what the runtime assembles as `sys.identity`.
    expect(shown).toBe(getSoulContent(PM));
  });

  it('an edit through the card reaches the runtime (today it writes a row the model never sees)', () => {
    insertMessage({ id: 'm1', agentId: PM, role: 'system', content: NO_REPLY_CLOSED_MARKER });

    writeAgentPromptSurface(PM, '# Identity\n\nYou are Kelly and you validate closes.');

    expect(getSoulContent(PM)).toBe('# Identity\n\nYou are Kelly and you validate closes.');
    expect(readAgentPromptSurface(PM)).toBe('# Identity\n\nYou are Kelly and you validate closes.');
  });

  it('the trainer rides the same surface', () => {
    insertMessage({ id: 't1', agentId: TRAINER, role: 'system', content: NO_REPLY_CLOSED_MARKER });
    expect(readAgentPromptSurface(TRAINER)).toBe(getSoulContent(TRAINER));
    writeAgentPromptSurface(TRAINER, '# Trainer\n\nYou make techniques.');
    expect(getSoulContent(TRAINER)).toBe('# Trainer\n\nYou make techniques.');
  });
});

describe('controls — nothing else moves', () => {
  it('the primary still reads and writes SOUL.md', () => {
    fs.writeFileSync(path.join(PROMPTS, 'SOUL.md'), '# Kevin\n\nBe useful.', 'utf-8');
    expect(readAgentPromptSurface(PRIMARY)).toBe('# Kevin\n\nBe useful.');
    writeAgentPromptSurface(PRIMARY, '# Kevin\n\nBe brief.');
    expect(fs.readFileSync(path.join(PROMPTS, 'SOUL.md'), 'utf-8')).toBe('# Kevin\n\nBe brief.');
  });

  it('an ordinary sub-agent shows its stored charter, and an edit round-trips to the runtime', () => {
    expect(readAgentPromptSurface(SUB)).toBe('You are Scout. Find things and report back.');
    writeAgentPromptSurface(SUB, 'You are Scout. Report only when asked.');
    expect(readAgentPromptSurface(SUB)).toBe('You are Scout. Report only when asked.');
    expect(getSoulContent(SUB)).toContain('You are Scout. Report only when asked.');
  });

  it('a legacy sub-agent with NO charter never shows an engine marker as its identity', () => {
    seedAgent('legacy-1', 'Legacy', null);
    insertMessage({ id: 'L1', agentId: 'legacy-1', role: 'system', content: NO_REPLY_CLOSED_MARKER });
    insertMessage({ id: 'L2', agentId: 'legacy-1', role: 'system', content: '[Mission] Watch the inbox.' });

    expect(readAgentPromptSurface('legacy-1')).toBe('[Mission] Watch the inbox.');
    // The RUNTIME sniff refuses the marker too — one rule, both surfaces.
    expect(getSoulContent('legacy-1')).toContain('[Mission] Watch the inbox.');
    expect(getSoulContent('legacy-1')).not.toContain('ended turn without replying');
  });

  it('a legacy sub-agent with ONLY markers falls through to the synthesized identity', () => {
    seedAgent('legacy-2', 'Ghost', null);
    insertMessage({ id: 'G1', agentId: 'legacy-2', role: 'system', content: NO_REPLY_CLOSED_MARKER });
    expect(readAgentPromptSurface('legacy-2')).toBe('');
    expect(getSoulContent('legacy-2')).not.toContain('ended turn without replying');
  });
});
