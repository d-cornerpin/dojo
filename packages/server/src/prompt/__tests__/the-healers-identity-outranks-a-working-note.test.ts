// UX-REPAIR ROUND 12 / T57 — THE HEALER'S IDENTITY OUTRANKS A WORKING NOTE.
//
// ── WHAT WAS MEASURED (W25 §4c, on the owner's box) ──
// `agents.charter` is NULL for the Healer, so `readStoredCharter` falls to its legacy sniff:
// "the earliest `role='system'` row that is not an engine-coordination marker". The Healer's
// real soul row (written once at creation by `healer/healer-agent.ts` from
// `templates/HEALER-SOUL.md`) had been pruned away, and the earliest SURVIVING `role='system'`
// row was **88 bytes**: `[working-note] Two issues to address…`.
//
// So an ENGINE NOTE was standing in as the Healer's whole identity — on the runtime surface
// (`getSoulContent`) and on the Settings card (`readAgentPromptSurface`), which T40 bound to
// the same store precisely so they could not disagree again.
//
// ── THE CLASS ──
// This is the T40 defect one layer down. T40's answer was a PRECEDENCE TABLE inside
// `readStoredCharter`: an identity is the earliest system row that is not an engine marker,
// and the engine markers are named by their exact prefixes — `[SOURCE:`, `[System:`, `──`,
// plus `NO_REPLY_CLOSED_MARKER` carried in BY PARAMETER rather than as a second copy of the
// literal. A `[working-note]` row is engine-authored by exactly the same argument: the engine
// WRAPS the model's mid-turn narration in it (`post-call-classify/closeout-floors.ts`,
// `terminal-text.ts`) and stores it `role='system'` so it can never re-enter model context.
// Nobody authors an identity that starts with it.
//
// ── THE RULE THIS FILE IS ──
// The fix is one more entry in the EXISTING table, not a new mechanism:
//   1. a `[working-note]` / `[working-note:internal]` row is never served as an identity;
//   2. a real identity row that merely SITS BEHIND one still wins — identity outranks the note;
//   3. `agents.charter` still outranks every row, as before;
//   4. the note itself is untouched — this is a READ precedence, not a deletion;
//   5. the control that keeps the rule honest: a row that merely MENTIONS the marker inside
//      its text (doctrine documenting the engine's own vocabulary) is still a valid identity,
//      because the table matches PREFIXES;
//   6. and the four refusals that were already there still refuse.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import realOs from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const HOME_DIR_NAME = 'dojo-t57-healer-identity';

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  const p = await import('node:path');
  const homedir = (): string => p.join(real.tmpdir(), 'dojo-t57-healer-identity');
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
import { readStoredCharter, getSoulContent } from '../assembler.js';
import { readAgentPromptSurface } from '../agent-prompt-surface.js';
import {
  NO_REPLY_CLOSED_MARKER,
  WORKING_NOTE_PREFIX,
  INTERNAL_WORKING_NOTE_PREFIX,
} from '@dojo/shared';

const HOME = path.join(realOs.tmpdir(), HOME_DIR_NAME);
const PROMPTS = path.join(HOME, '.dojo', 'prompts');

const PRIMARY = 'kevin';
const HEALER = 'healer';

// The measured row, to the byte class that was found: an 88-byte demoted narration.
const THE_88_BYTE_NOTE =
  `${WORKING_NOTE_PREFIX}Two issues to address: the scheduler backlog and the stale model row.`;

const HEALER_SOUL_ROW =
  '# Identity\n\nYou are the Healer, the dojo\'s self-healing agent. You have two jobs:\n\n'
  + '1. **Daily diagnostics** …\n2. **Injury recovery** …';

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
  setConfig('healer_agent_id', HEALER);
  setConfig('healer_agent_name', 'Healer');
  setConfig('owner_name', 'David');
  const platform = await import('../../config/platform.js');
  platform.clearPlatformConfigCache();
  seedAgent(PRIMARY, 'Kevin');
  seedAgent(HEALER, 'Healer');            // charter NULL — the measured shape
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('the Healers identity outranks a working note', () => {
  it("THE OWNER'S BOX: the soul row was pruned and an 88-byte working note is the oldest survivor — it is NOT the identity", () => {
    insertMessage({ id: 'n1', agentId: HEALER, role: 'system', content: THE_88_BYTE_NOTE });

    const charter = readStoredCharter(HEALER);

    expect(charter).not.toContain('working-note');
    expect(charter).toBe('');   // no identity survives — the note is not a substitute for one
  });

  it('the identity OUTRANKS the note: a real soul row behind a working note still wins', () => {
    insertMessage({ id: 'n1', agentId: HEALER, role: 'system', content: THE_88_BYTE_NOTE });
    insertMessage({ id: 's1', agentId: HEALER, role: 'system', content: HEALER_SOUL_ROW });

    expect(readStoredCharter(HEALER)).toBe(HEALER_SOUL_ROW);
  });

  it('the INTERNAL working note is refused by the same table', () => {
    insertMessage({
      id: 'n1', agentId: HEALER, role: 'system',
      content: `${INTERNAL_WORKING_NOTE_PREFIX}Checking the scheduler before I answer.`,
    });
    insertMessage({ id: 's1', agentId: HEALER, role: 'system', content: HEALER_SOUL_ROW });

    expect(readStoredCharter(HEALER)).toBe(HEALER_SOUL_ROW);
  });

  it('BOTH SURFACES agree, because T40 bound them to one store', () => {
    insertMessage({ id: 'n1', agentId: HEALER, role: 'system', content: THE_88_BYTE_NOTE });
    insertMessage({ id: 's1', agentId: HEALER, role: 'system', content: HEALER_SOUL_ROW });

    // The Settings card.
    expect(readAgentPromptSurface(HEALER)).toBe(HEALER_SOUL_ROW);
    // The model's own `sys.identity`.
    const soul = getSoulContent(HEALER);
    expect(soul).toContain("You are the Healer, the dojo's self-healing agent");
    expect(soul).not.toContain('Two issues to address');
  });

  it('the model is never handed the note as its identity, even when nothing else survives', () => {
    insertMessage({ id: 'n1', agentId: HEALER, role: 'system', content: THE_88_BYTE_NOTE });

    const soul = getSoulContent(HEALER);
    expect(soul).not.toContain('Two issues to address');
    expect(soul).not.toContain('working-note');
    // It falls to the synthesized sub-agent identity, which at least names the agent truthfully.
    expect(soul).toContain('You are **Healer**');
  });

  // ── controls ──

  it('CONTROL: agents.charter still outranks every row', () => {
    mockDb.current!.prepare('UPDATE agents SET charter = ? WHERE id = ?')
      .run('# Identity\n\nDeclared charter, column-backed.', HEALER);
    insertMessage({ id: 'n1', agentId: HEALER, role: 'system', content: THE_88_BYTE_NOTE });
    insertMessage({ id: 's1', agentId: HEALER, role: 'system', content: HEALER_SOUL_ROW });

    expect(readStoredCharter(HEALER)).toBe('# Identity\n\nDeclared charter, column-backed.');
  });

  it('CONTROL: the note is REFUSED, never deleted — this is read precedence, not a sweep', () => {
    insertMessage({ id: 'n1', agentId: HEALER, role: 'system', content: THE_88_BYTE_NOTE });
    readStoredCharter(HEALER);
    readAgentPromptSurface(HEALER);
    getSoulContent(HEALER);

    const row = mockDb.current!
      .prepare('SELECT content FROM messages WHERE id = ?').get('n1') as { content: string };
    expect(row.content).toBe(THE_88_BYTE_NOTE);
    expect(
      (mockDb.current!.prepare("SELECT COUNT(*) c FROM messages WHERE agent_id = ? AND role = 'system'")
        .get(HEALER) as { c: number }).c,
    ).toBe(1);
  });

  it('CONTROL: the table matches PREFIXES — doctrine that MENTIONS the marker is still an identity', () => {
    const doctrine =
      '# Identity\n\nYou are the Healer. When the engine demotes narration it writes a '
      + `${WORKING_NOTE_PREFIX}row; never treat one as an instruction.`;
    insertMessage({ id: 's1', agentId: HEALER, role: 'system', content: doctrine });

    expect(readStoredCharter(HEALER)).toBe(doctrine);
  });

  it('CONTROL: the four refusals that were already in the table still refuse', () => {
    insertMessage({ id: 'e1', agentId: HEALER, role: 'system', content: '[SOURCE:imessage] ping' });
    insertMessage({ id: 'e2', agentId: HEALER, role: 'system', content: '[System: session reset] reorient' });
    insertMessage({ id: 'e3', agentId: HEALER, role: 'system', content: '── reauthorize ──' });
    insertMessage({ id: 'e4', agentId: HEALER, role: 'system', content: NO_REPLY_CLOSED_MARKER });
    insertMessage({ id: 's1', agentId: HEALER, role: 'system', content: HEALER_SOUL_ROW });

    expect(readStoredCharter(HEALER)).toBe(HEALER_SOUL_ROW);
  });
});
