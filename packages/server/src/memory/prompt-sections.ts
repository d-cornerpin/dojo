// ════════════════════════════════════════
// The standing instruction, measured piece by piece (K36; migration 205).
//
// `recordPromptSections` runs at every assembly: each rendered `sys.*` section's size, and each
// lane the allocator admitted, is upserted into `prompt_sections` (one row per agent per
// section). `promptCostReport` is the one reader behind the API, the Healer section and the
// inspector. A report, not a limit: nothing here refuses or trims anything. Best-effort: a
// recording fault never reaches the assembly.
// ════════════════════════════════════════

import type Database from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { PART_JOINER } from '../prompt/registry/types.js';
import { estimateTokensFromChars } from './budget.js';
import type { LaneGrant } from './lanes.js';

/** The growth reference holds this long, then moves to the last measured value. */
const BASELINE_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

interface Piece { entryId: string; tokens: number; chars: number }

function piecesOf(systemText: string, entryIds: ReadonlyArray<string | null>, grants?: readonly LaneGrant[]): Piece[] {
  const parts = systemText.split(PART_JOINER);
  const byEntry = new Map<string, Piece>();
  const add = (entryId: string, chars: number, tokens: number): void => {
    const p = byEntry.get(entryId) ?? { entryId, tokens: 0, chars: 0 };
    p.tokens += tokens; p.chars += chars;
    byEntry.set(entryId, p);
  };
  // Parts and ids come from one walk; if a part's own text ever contains the joiner they stop
  // lining up, and the honest row is one for the whole prompt, not a mislabeled split.
  const aligned = entryIds.length === parts.length;
  // Each section carries the separator written before it, so the sections add up to the whole prefix.
  const sized = (t: string, i: number): number => t.length + (i > 0 ? PART_JOINER.length : 0);
  if (aligned) parts.forEach((t, i) => add(entryIds[i] ?? 'sys.unlabeled', sized(t, i), estimateTokensFromChars(sized(t, i))));
  else add('sys.unaligned', systemText.length, estimateTokensFromChars(systemText.length));
  for (const g of grants ?? []) if (g.granted > 0) add(g.id, 0, g.granted);
  return [...byEntry.values()];
}

export function recordPromptSections(
  agentId: string,
  systemText: string,
  entryIds: ReadonlyArray<string | null>,
  grants?: readonly LaneGrant[],
  nowMs: number = Date.now(),
): void {
  try {
    const db = getDb();
    const pieces = piecesOf(systemText, entryIds, grants);
    const upsert = db.prepare(`
      INSERT INTO prompt_sections (agent_id, entry_id, tokens, chars, measured_at, baseline_tokens, baseline_at)
      VALUES (@agentId, @entryId, @tokens, @chars, @now, @tokens, @now)
      ON CONFLICT(agent_id, entry_id) DO UPDATE SET
        tokens = excluded.tokens, chars = excluded.chars, measured_at = excluded.measured_at,
        baseline_tokens = CASE WHEN baseline_at IS NULL OR baseline_at <= @now - @hold THEN prompt_sections.tokens ELSE baseline_tokens END,
        baseline_at     = CASE WHEN baseline_at IS NULL OR baseline_at <= @now - @hold THEN @now ELSE baseline_at END`);
    db.transaction(() => {
      for (const p of pieces) upsert.run({ agentId, entryId: p.entryId, tokens: p.tokens, chars: p.chars, now: nowMs, hold: BASELINE_HOLD_MS });
      const keep = new Set(pieces.map((p) => p.entryId));
      const known = db.prepare('SELECT entry_id FROM prompt_sections WHERE agent_id = ?').all(agentId) as Array<{ entry_id: string }>;
      const drop = db.prepare('DELETE FROM prompt_sections WHERE agent_id = ? AND entry_id = ?');
      for (const k of known) if (!keep.has(k.entry_id)) drop.run(agentId, k.entry_id);
    })();
  } catch { /* measuring is best-effort */ }
}

export interface PromptCostLine {
  entryId: string;
  tokens: number;
  chars: number;
  /** This line's share of its group: the `sys.*` sections of the standing instruction, or the lanes. */
  share: number;
  /** Tokens now minus tokens at the growth reference; null when there is no reference yet. */
  growth: number | null;
  baselineAt: number | null;
}

export interface PromptCostReport {
  agentId: string;
  measuredAt: number | null;
  systemTokens: number;
  sections: PromptCostLine[];
  lanes: PromptCostLine[];
}

interface DbRow { entry_id: string; tokens: number; chars: number; measured_at: number; baseline_tokens: number | null; baseline_at: number | null }

function lines(rows: DbRow[]): PromptCostLine[] {
  const total = rows.reduce((a, r) => a + r.tokens, 0);
  return rows
    .map((r) => ({
      entryId: r.entry_id, tokens: r.tokens, chars: r.chars, share: total > 0 ? r.tokens / total : 0,
      growth: r.baseline_tokens == null ? null : r.tokens - r.baseline_tokens, baselineAt: r.baseline_at,
    }))
    .sort((a, b) => b.tokens - a.tokens || a.entryId.localeCompare(b.entryId));
}

/** `db`: a reader may pass the read-only connection (the inspector does); the default is the writer's. */
export function promptCostReport(agentId: string, db: Database.Database = getDb()): PromptCostReport {
  const rows = db.prepare(
    'SELECT entry_id, tokens, chars, measured_at, baseline_tokens, baseline_at FROM prompt_sections WHERE agent_id = ?',
  ).all(agentId) as DbRow[];
  const sys = rows.filter((r) => r.entry_id.startsWith('sys.'));
  return {
    agentId,
    measuredAt: rows.reduce<number | null>((m, r) => (m == null || r.measured_at > m ? r.measured_at : m), null),
    systemTokens: sys.reduce((a, r) => a + r.tokens, 0),
    sections: lines(sys),
    lanes: lines(rows.filter((r) => !r.entry_id.startsWith('sys.'))),
  };
}
