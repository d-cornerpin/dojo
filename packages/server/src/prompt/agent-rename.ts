// The one rename door: the agent row, its platform role name and its stored soul files change together here.
// The re-fill rewrites per-box soul files (`SOUL.md`, `*-SOUL.md`) by exact word-boundary match of the OLD name.
// It never touches `templates/*.md`, `prompt/templates.ts` or `agents.charter` (a charter may name others).

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { clearPlatformConfigCache } from '../config/platform.js';
import { UNSUBSTITUTED } from './assembler.js';
import { caseVariantClash, caseVariantClashMessage } from '../agent/tool-helpers.js';
import { homeDir } from '../home.js';

const logger = createLogger('agent-rename');
const PROMPTS_DIR = (): string => path.join(homeDir(), '.dojo', 'prompts');

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
  readonly souls: readonly SoulRefill[];
  /** Souls left alone because they still carry `{{…}}`, see `readSoulFile`'s re-seed rule. */
  readonly skippedUnsubstituted: readonly string[];
  /** Set when the rename was refused (case-only clash with another live agent's name); nothing was written. */
  readonly refusal?: string;
}

/** Each `<role>_agent_name` config key and the `<role>_agent_id` key that names its agent row. */
export const ROLE_NAME_TO_ID_KEY: Readonly<Record<string, string>> = {
  primary_agent_name: 'primary_agent_id',
  pm_agent_name: 'pm_agent_id',
  trainer_agent_name: 'trainer_agent_id',
  healer_agent_name: 'healer_agent_id',
  dreamer_agent_name: 'dreamer_agent_id',
};

export function roleNameKeyToIdKey(key: string): string | null {
  return ROLE_NAME_TO_ID_KEY[key] ?? null;
}

function platformNameKeyFor(agentId: string): string | null {
  const db = getDb();
  for (const [nameKey, idKey] of Object.entries(ROLE_NAME_TO_ID_KEY)) {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(idKey) as { value: string } | undefined;
    if (row?.value === agentId) return nameKey;
  }
  return null;
}

// Exact word-boundary match: "Max" must not hit "Maximum". The lookarounds are Unicode-aware (`\b` is ASCII-only)
// and a possessive still matches; the name is regex-escaped because display names are free text.
function wordBoundary(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
}

/** Stored soul files: `SOUL.md` and `*-SOUL.md` (what `soulFileForAgent` can return), never `USER.md`. */
function storedSoulFiles(): string[] {
  try {
    return fs.readdirSync(PROMPTS_DIR())
      .filter((f) => f === 'SOUL.md' || f.endsWith('-SOUL.md'))
      .sort();
  } catch {
    return [];   // no prompts directory on this box yet: nothing stored, nothing to re-fill
  }
}

/** Rename an agent: the only place a display name changes. A no-op (unknown, blank or same name) writes nothing. */
export function renameAgent(agentId: string, requestedName: string): RenameOutcome {
  const db = getDb();
  const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
  const oldName = row?.name ?? '';
  const newName = requestedName.trim();
  const noop: RenameOutcome = { renamed: false, agentId, oldName, newName, souls: [], skippedUnsubstituted: [] };
  if (!row || !newName || newName === oldName) return noop;

  // Refuse, before any write, a name that differs from another live agent's only by capital letters.
  const clash = caseVariantClash(newName, agentId);
  if (clash) return { ...noop, refusal: caseVariantClashMessage(clash.name) };

  // The row and the role name move together or not at all.
  const nameKey = platformNameKeyFor(agentId);
  db.transaction(() => {
    db.prepare("UPDATE agents SET name = ?, updated_at = datetime('now') WHERE id = ?").run(newName, agentId);
    if (nameKey) {
      setConfigValue(nameKey, newName);
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

      // A soul still carrying `{{…}}` is engine-seeded; `readSoulFile` re-seeds it with the current name, so skip it.
      if (UNSUBSTITUTED.test(stored)) { skippedUnsubstituted.push(file); continue; }

      pattern.lastIndex = 0;
      const replacements = (stored.match(pattern) ?? []).length;
      // A soul that does not name this agent is not rewritten, so its mtime does not move.
      if (replacements === 0) continue;

      fs.writeFileSync(full, stored.replace(pattern, () => newName), 'utf-8');
      souls.push({ file, replacements });
    } catch (err) {
      // A failed re-fill is logged and must not undo the rename already committed.
      logger.error('rename could not re-fill a stored soul', {
        agentId, file, oldName, newName, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Audit note (old to new, count per soul), written only when a soul was rewritten. `action_type` is `file_write`
  // because the audit_log CHECK constraint has no rename kind; `detail.kind` says `agent_rename`.
  // `result` is 'success' so the error counters in healer/diagnostic.ts and memory/briefing.ts ignore it.
  // Best-effort: an audit failure never fails a rename that has already landed.
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
