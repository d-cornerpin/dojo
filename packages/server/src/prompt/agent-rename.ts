// THE ONE RENAME DOOR, AND THE SOULS THAT FOLLOW IT — UX-REPAIR ROUND 12 T50 (owner ruling 1).
//
// ── THE OWNER'S RULING ──
// "RE-FILL ON RENAME." He renamed an agent and wants its souls to follow. Exact word-boundary
// replacement of the OLD display name only; an audit note records old→new and the count; NO
// re-seed; NO other text touched; and owner-authored souls get the same treatment — that is
// the ruling, not an oversight.
//
// ── WHY THIS IS A MERGER AND NOT A HOOK ──
// Step-0 found renames flowing through THREE inline writes:
//   1. `gateway/routes/agents.ts`      PUT /api/agents/:id           — the owner's Settings card
//   2. `agent/tools/cat/agents.ts`     update_agent                  — the model
//   3. `gateway/routes/config.ts`      PUT /settings/<role>_agent_name
// and the third is the one that matters most. `substitutePlatformNames` bakes
// `getPMAgentName()` / `getTrainerAgentName()` / `getPrimaryAgentName()` INTO a stored soul at
// seed time, and those getters read the CONFIG key, not the `agents` row — so the souls that
// actually carry a display name are renamed by the door that never touches `agents.name` at
// all. Measured on the owner's box: `PM-SOUL.md` 13,922 B and `TRAINER-SOUL.md` 8,057 B, names
// substituted, zero `{{` remaining. A hook on doors 1 and 2 would have missed the whole case.
//
// So the three writes MERGE here. The precedent is `agent/agent-status.ts`'s `writeAgentStatus`,
// which absorbed five byte-shaped copies of a status write for exactly this reason: a rule that
// must hold on every rename cannot live in one of three places. A conformance test pins the
// census, so a fourth door cannot grow back.
//
// ── WHY IT LIVES IN `prompt/` ──
// Because the reason the door exists is the identity, and `prompt/` already owns that: T40 put
// `agent-prompt-surface.ts` here as "the read/write door every surface goes through", and that
// module already writes `agents.charter`. A rename IS an identity write; this is its neighbour.
//
// ── SCOPE, SAID OUT LOUD ──
// The re-fill rewrites STORED PER-BOX SOUL FILES — `~/.dojo/prompts/SOUL.md` and `*-SOUL.md`,
// the files `soulFileForAgent` can return. It never touches `templates/*.md` (the shipped
// doctrine, the same for every box) and never touches `prompt/templates.ts` (the in-code
// defaults). A test asserts both are byte-unmoved across a rename. `agents.charter` is
// DELIBERATELY out of scope: a charter is a creator's task instructions for one agent, where a
// name may be a deliberate reference to somebody else, and the ruling's word is "souls" —
// recorded as a residual rather than smuggled in.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { clearPlatformConfigCache } from '../config/platform.js';
import { UNSUBSTITUTED } from './assembler.js';

const logger = createLogger('agent-rename');
const PROMPTS_DIR = (): string => path.join(os.homedir(), '.dojo', 'prompts');

/** One stored soul the rename rewrote, and how many times. */
export interface SoulRefill {
  readonly file: string;
  readonly replacements: number;
}

export interface RenameOutcome {
  /** False when the request was a no-op: unknown agent, blank name, or the name it already had. */
  readonly renamed: boolean;
  readonly agentId: string;
  readonly oldName: string;
  readonly newName: string;
  /** Every stored soul that named the agent, with its count. Empty when none did. */
  readonly souls: readonly SoulRefill[];
  /** Souls left alone because they still carry `{{…}}` — see `readSoulFile`'s re-seed rule. */
  readonly skippedUnsubstituted: readonly string[];
}

/**
 * THE PLATFORM ROLE NAMES, AND THE ID KEY EACH ONE IS ABOUT.
 *
 * `config/platform.ts` reads `<role>_agent_name` for the display name and `<role>_agent_id` for
 * the row. The config door renames by writing the FIRST of those, which is why it has to be
 * able to find the second. Declared as one map so the two doors cannot disagree about the list.
 */
export const ROLE_NAME_TO_ID_KEY: Readonly<Record<string, string>> = {
  primary_agent_name: 'primary_agent_id',
  pm_agent_name: 'pm_agent_id',
  trainer_agent_name: 'trainer_agent_id',
  imaginer_agent_name: 'imaginer_agent_id',
  healer_agent_name: 'healer_agent_id',
  dreamer_agent_name: 'dreamer_agent_id',
};

/** The `<role>_agent_id` key a config key renames through, or null when the key is not a role name. */
export function roleNameKeyToIdKey(key: string): string | null {
  return ROLE_NAME_TO_ID_KEY[key] ?? null;
}

/** The `<role>_agent_name` key this agent's display name lives in, or null for an ordinary agent. */
function platformNameKeyFor(agentId: string): string | null {
  const db = getDb();
  for (const [nameKey, idKey] of Object.entries(ROLE_NAME_TO_ID_KEY)) {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(idKey) as { value: string } | undefined;
    if (row?.value === agentId) return nameKey;
  }
  return null;
}

/**
 * EXACT WORD-BOUNDARY MATCH, and it is the whole discipline of this task.
 *
 * An agent called "Max" must not turn "Maximum" into "Reximum", "Maxwell" into "Rexwell", or
 * touch "climax". `\b` is the usual reach and it is wrong here: it is defined against ASCII
 * `\w`, so a name with an accent or a non-Latin script gets boundaries in the middle of itself.
 * The lookarounds below are Unicode-aware — a match must not be flanked by any letter, digit or
 * underscore in any script. A possessive ("Max's") still matches, because an apostrophe is
 * none of those, which is the behaviour a reader of the soul would expect.
 *
 * The name is regex-escaped: display names are free text and a person may legitimately be
 * called "C++" or "Agent (Beta)".
 */
function wordBoundary(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
}

/**
 * The stored soul FILES on this box: `SOUL.md` and every `<ROLE|ID>-SOUL.md`.
 *
 * Exactly the set `soulFileForAgent` can return. `USER.md` is excluded deliberately — it is the
 * owner's own profile, not an agent's identity, and nothing in the ruling asks for it.
 */
function storedSoulFiles(): string[] {
  try {
    return fs.readdirSync(PROMPTS_DIR())
      .filter((f) => f === 'SOUL.md' || f.endsWith('-SOUL.md'))
      .sort();
  } catch {
    return [];   // no prompts directory on this box yet: nothing stored, nothing to re-fill
  }
}

/**
 * RENAME AN AGENT — the only place in the tree that changes a display name.
 *
 * Writes the row, writes the platform role name when the agent has one, and re-fills every
 * stored soul that referenced the old name. Returns what it did, so a caller can report it.
 *
 * A no-op (unknown agent, blank name, or the name it already had) writes NOTHING — not the row,
 * not the config, not a soul, not an audit line.
 */
export function renameAgent(agentId: string, requestedName: string): RenameOutcome {
  const db = getDb();
  const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
  const oldName = row?.name ?? '';
  const newName = requestedName.trim();
  const noop: RenameOutcome = { renamed: false, agentId, oldName, newName, souls: [], skippedUnsubstituted: [] };
  if (!row || !newName || newName === oldName) return noop;

  // The ROW and the ROLE NAME move together or not at all. They are two halves of one fact,
  // and a box that carries them apart is the exact staleness this task is about: the row says
  // one thing, `getPMAgentName()` says another, and the soul was seeded from the second.
  const nameKey = platformNameKeyFor(agentId);
  db.transaction(() => {
    db.prepare("UPDATE agents SET name = ?, updated_at = datetime('now') WHERE id = ?").run(newName, agentId);
    if (nameKey) {
      db.prepare(
        `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      ).run(nameKey, newName);
    }
  })();
  if (nameKey) clearPlatformConfigCache();

  const souls: SoulRefill[] = [];
  const skippedUnsubstituted: string[] = [];
  const pattern = wordBoundary(oldName);
  for (const file of storedSoulFiles()) {
    const full = path.join(PROMPTS_DIR(), file);
    try {
      const stored = fs.readFileSync(full, 'utf-8');

      // A soul still carrying `{{…}}` was written by the engine's own default-seeding and was
      // never an authored identity (W24/W25). Rename-patching it would write the new name into
      // text that `readSoulFile` is about to replace wholesale from the shipped template — and
      // that re-seed already substitutes the CURRENT name, which this function has just made
      // correct. Left alone on purpose: NO re-seed here, by the ruling, and none needed.
      if (UNSUBSTITUTED.test(stored)) { skippedUnsubstituted.push(file); continue; }

      pattern.lastIndex = 0;
      const replacements = (stored.match(pattern) ?? []).length;
      // A soul that does not name this agent is not rewritten at all — no write, so not even
      // its mtime moves. "Unrelated souls untouched" is a control, and this line is it.
      if (replacements === 0) continue;

      fs.writeFileSync(full, stored.replace(pattern, newName), 'utf-8');
      souls.push({ file, replacements });
    } catch (err) {
      // A soul that could not be re-filled must be LOUD, and must not undo a rename that has
      // already landed in the database. The row is the truth; this is the follow-through.
      logger.error('rename could not re-fill a stored soul', {
        agentId, file, oldName, newName, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // THE AUDIT NOTE the ruling asks for: old→new and the count, per soul touched.
  //
  // `action_type` is `file_write` and NOT a new `agent_rename` value, deliberately: the column
  // carries a CHECK constraint (`db/migrations.ts:83`) over six declared kinds, and widening a
  // constraint by migration to label one row is a schema change borrowed against a sentence.
  // `file_write` is also the honest word — the durable artifact of a re-fill IS a set of writes
  // to `~/.dojo/prompts/*.md` — so the row is written only when a soul was actually rewritten,
  // and `detail.kind` says `agent_rename` so it is greppable. A rename that touched no soul
  // still leaves the log line below, which is the whole record in that case.
  //
  // `result` is 'success' by this table's convention: the error counters in
  // `healer/diagnostic.ts` and `memory/briefing.ts` key off `result='error'` /
  // `action_type='error'`, so this row is inert to them. Best-effort — an audit hiccup never
  // fails a rename that has already landed.
  const totalReplacements = souls.reduce((n, s) => n + s.replacements, 0);
  if (souls.length > 0) {
    try {
      db.prepare(
        `INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at)
         VALUES (?, ?, 'file_write', ?, 'success', ?, datetime('now'))`,
      ).run(
        uuidv4(), agentId, `${oldName} → ${newName}`,
        JSON.stringify({ kind: 'agent_rename', oldName, newName, replacements: totalReplacements, souls, skippedUnsubstituted }),
      );
    } catch (err) {
      logger.warn('rename audit write failed', { agentId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  logger.info('agent renamed', {
    agentId, oldName, newName, roleNameKey: nameKey, soulsRefilled: souls.length, replacements: totalReplacements,
    skippedUnsubstituted,
  });

  return { renamed: true, agentId, oldName, newName, souls, skippedUnsubstituted };
}
