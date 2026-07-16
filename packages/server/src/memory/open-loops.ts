// ════════════════════════════════════════
// RC-2: structured, retirable open loops (store + parse + guard)
// ════════════════════════════════════════
//
// Before this, an unresolved question survived compaction ONLY as prose inside an
// immutable summary. It could never be retired, so a transient "I couldn't read
// your last message" self-narration became a durable obligation and got re-raised
// to the owner five times over 36 hours (the 7/12 poison). This module moves open
// loops out of summary prose into structured `open_loops` rows (migration 107) that
// the engine can:
//   - PARSE from a freshly generated depth-0 summary's fenced OPEN-LOOPS section,
//     upsert (deduped), and STRIP from the stored summary text,
//   - RESOLVE from the same summary's RESOLVED/CLOSED section, from the agent's
//     loop_resolve tool, or from an owner dismissal,
//   - GUARD against the specific 7/12 poison: a loop asserting a missing/unread
//     inbound is checkable against the store, which is ground truth,
//   - INJECT (open rows only) into the volatile lane on human turns, and
//   - AGE to 'stale' WITHOUT dropping (surfaced once in the daily brief; only an
//     explicit resolution/dismissal closes them, per the RC-2 History-check spec).
//
// Everything here is deterministic (no embeddings) and defensive (weak summarizer
// models format loosely; a parse failure stores the summary unchanged and logs).

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { summaryPartyTag, convKeyToLabel } from './party-label.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('open-loops');

export type OpenLoopStatus = 'open' | 'resolved' | 'stale';

export interface OpenLoopRow {
  id: string;
  agent_id: string;
  conv_key: string | null;
  description: string;
  source_message_id: string | null;
  status: OpenLoopStatus;
  resolved_by_message_id: string | null;
  created_at: string;
  updated_at: string;
}

// Aging threshold: an open loop with no answer this long flips to 'stale' (a
// marker, NOT a drop). Surfaced in the daily brief; only an explicit resolution or
// owner dismissal closes it.
const STALE_AFTER_DAYS = 7;
// Injection budget: cap the whole OPEN LOOPS block so it never crowds the volatile
// lane on a floor model.
const INJECTION_MAX_CHARS = 600;
// Cross-conversation overflow shown on a turn (labeled by party), beyond the
// current conversation's own open loops.
const CROSS_CONV_OVERFLOW_MAX = 3;
// id prefix length shown in the block + accepted by loop_resolve.
const ID_PREFIX_LEN = 8;
// Store-guard lookback for an unserved inbound.
const UNSERVED_INBOUND_WINDOW_HOURS = 72;

// ── Normalization + deterministic similarity (dedup / resolve matching) ──

export function normalizeLoopDescription(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic, embedding-free similarity. True when descriptions are:
 *   - exact after normalization, OR
 *   - a substring either way, OR
 *   - high symmetric word-set overlap (Jaccard >= 0.6, catches rewordings), OR
 *   - high directional coverage (>= 0.75 of one description's significant words
 *     appear in the other, min 3 significant words). The directional case matches
 *     a RESOLVED/CLOSED line that describes the SAME item with extra words
 *     ("send the flight codes to Maya" vs "sent the flight codes to Maya, done").
 * Words shorter than three chars are ignored. Used for both dedup and resolution.
 */
export function loopDescriptionsSimilar(a: string, b: string): boolean {
  const na = normalizeLoopDescription(a);
  const nb = normalizeLoopDescription(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 8 && nb.length >= 8 && (na.includes(nb) || nb.includes(na))) return true;
  const sa = new Set(na.split(' ').filter((w) => w.length > 2));
  const sb = new Set(nb.split(' ').filter((w) => w.length > 2));
  if (sa.size === 0 || sb.size === 0) return false;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  if (union > 0 && inter / union >= 0.6) return true;
  const coverage = Math.max(inter / sa.size, inter / sb.size);
  return coverage >= 0.75 && Math.min(sa.size, sb.size) >= 3;
}

// ── Store-contradiction guard (RC-2 item 5) ──

// A loop whose description asserts a MISSING / UNREAD inbound. The store is ground
// truth: if every recent inbound was served, this belief is false.
const MISSING_INBOUND_RE =
  /(?:\blost\b|never (?:saw|read|received)|couldn'?t (?:see|read)|got eaten|(?:memory )?(?:ate|eaten)|compressed before)/i;

export function assertsMissingInbound(description: string): boolean {
  return MISSING_INBOUND_RE.test(description);
}

/**
 * True when at least one inbound (role='user') row is UNSERVED (conv_key IS NULL)
 * within the window. The pickup claim stamps conv_key on the trigger row, so a
 * genuinely unread message never became a trigger and stays NULL. If NONE are
 * unserved, a "your message was lost" claim is contradicted by the store. Fails
 * OPEN (returns true) on error so the guard never wrongly rejects a real loop.
 */
function hasUnservedInboundRecently(agentId: string, windowHours: number): boolean {
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT 1 FROM messages
          WHERE agent_id = ? AND role = 'user' AND conv_key IS NULL
            AND created_at >= datetime('now', ?)
          LIMIT 1`,
      )
      .get(agentId, `-${Math.max(1, Math.floor(windowHours))} hours`);
    return !!row;
  } catch {
    return true;
  }
}

/** True when the conversation identified by conv_key has at least one SERVED
 *  (claimed) inbound row, i.e. the agent has actually been receiving + serving
 *  messages there. */
function conversationHasServedInbound(agentId: string, convKey: string): boolean {
  try {
    const db = getDb();
    const row = db
      .prepare(`SELECT 1 FROM messages WHERE agent_id = ? AND role = 'user' AND conv_key = ? LIMIT 1`)
      .get(agentId, convKey);
    return !!row;
  } catch {
    return false;
  }
}

// ── Insert / dedup / resolve ──

export interface InsertLoopParams {
  agentId: string;
  convKey: string | null;
  description: string;
  sourceMessageId: string | null;
}

/**
 * Insert a new open loop, deduped and store-guarded. Returns the new row id, or
 * null when skipped as a duplicate or REJECTED as a store-contradicted
 * missing-inbound claim (logged at info with the description).
 */
export function insertOpenLoop(params: InsertLoopParams): string | null {
  const { agentId, convKey, description, sourceMessageId } = params;
  const desc = description.trim();
  if (!desc) return null;

  // Store-contradiction guard: reject a missing-inbound claim the store disproves.
  if (
    assertsMissingInbound(desc) &&
    !hasUnservedInboundRecently(agentId, UNSERVED_INBOUND_WINDOW_HOURS) &&
    (!convKey || conversationHasServedInbound(agentId, convKey))
  ) {
    logger.info(
      'open loop rejected: missing-inbound claim contradicted by the store (every recent inbound was served)',
      { agentId, convKey, description: desc },
      agentId,
    );
    return null;
  }

  try {
    const db = getDb();
    // Dedup: same conv_key (NULL matched as NULL) + similar/substring description
    // among rows still open. Deterministic, no embeddings.
    const existing = db
      .prepare(
        `SELECT id, description FROM open_loops
          WHERE agent_id = ? AND status = 'open'
            AND ((conv_key IS NULL AND ? IS NULL) OR conv_key = ?)`,
      )
      .all(agentId, convKey, convKey) as Array<{ id: string; description: string }>;
    for (const e of existing) {
      if (loopDescriptionsSimilar(e.description, desc)) {
        db.prepare(`UPDATE open_loops SET updated_at = datetime('now') WHERE id = ?`).run(e.id);
        return null; // already tracked
      }
    }
    const id = uuidv4();
    db.prepare(
      `INSERT INTO open_loops (id, agent_id, conv_key, description, source_message_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))`,
    ).run(id, agentId, convKey, desc, sourceMessageId);
    logger.info('open loop recorded', { agentId, convKey, id }, agentId);
    return id;
  } catch (err) {
    logger.warn('insertOpenLoop failed (non-fatal)', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
}

/**
 * Mark still-open loops that match any resolved-description as resolved. Matching
 * is the same deterministic similarity used for dedup. Returns the count closed.
 */
export function resolveMatchingLoops(
  agentId: string,
  resolvedDescriptions: string[],
  opts?: { resolvedByMessageId?: string | null },
): number {
  const descs = resolvedDescriptions.map((d) => d.trim()).filter(Boolean);
  if (descs.length === 0) return 0;
  let closed = 0;
  try {
    const db = getDb();
    const open = db
      .prepare(`SELECT id, description FROM open_loops WHERE agent_id = ? AND status = 'open'`)
      .all(agentId) as Array<{ id: string; description: string }>;
    const upd = db.prepare(
      `UPDATE open_loops SET status = 'resolved', resolved_by_message_id = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'open'`,
    );
    for (const row of open) {
      if (descs.some((rd) => loopDescriptionsSimilar(rd, row.description))) {
        upd.run(opts?.resolvedByMessageId ?? null, row.id);
        closed++;
      }
    }
    if (closed > 0) logger.info('open loops resolved via summary RESOLVED/CLOSED', { agentId, closed }, agentId);
  } catch (err) {
    logger.warn('resolveMatchingLoops failed (non-fatal)', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  return closed;
}

/**
 * Retire the single open/stale loop whose id starts with `idPrefix` (the agent's
 * loop_resolve tool, or an owner dismissal). Ambiguous or missing prefixes return
 * a guidance message. Returns a { ok, message } for the tool result.
 */
export function resolveOpenLoopByPrefix(
  agentId: string,
  idPrefix: string,
  note?: string,
): { ok: boolean; message: string } {
  const prefix = (idPrefix ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!prefix || prefix.length < 4) {
    return {
      ok: false,
      message: 'Error: pass the open-loop id prefix (at least 4 characters) shown in the OPEN LOOPS block.',
    };
  }
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM open_loops
          WHERE agent_id = ? AND status IN ('open', 'stale') AND lower(id) LIKE ?
          ORDER BY created_at ASC`,
      )
      .all(agentId, `${prefix}%`) as OpenLoopRow[];
    if (rows.length === 0) {
      return { ok: false, message: `No open loop matches "${prefix}". It may already be resolved.` };
    }
    if (rows.length > 1) {
      const opts = rows
        .map((r) => `[${r.id.slice(0, ID_PREFIX_LEN)}] ${r.description.slice(0, 60)}`)
        .join('; ');
      return { ok: false, message: `Ambiguous prefix "${prefix}" matches ${rows.length} loops: ${opts}. Use a longer prefix.` };
    }
    const r = rows[0];
    db.prepare(`UPDATE open_loops SET status = 'resolved', updated_at = datetime('now') WHERE id = ?`).run(r.id);
    logger.info('open loop resolved by agent', { agentId, id: r.id, note: note ?? null }, agentId);
    return { ok: true, message: `Resolved open loop: ${r.description}` };
  } catch (err) {
    return { ok: false, message: `Error resolving open loop: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Staleness (aging without dropping) ──

/** Flip open loops older than the threshold to 'stale'. Returns the count flipped.
 *  Stale loops are NOT dropped and NOT injected per turn; they surface in the daily
 *  brief and can only be closed by explicit resolution/dismissal. */
export function markStaleLoops(agentId: string, thresholdDays: number = STALE_AFTER_DAYS): number {
  try {
    const db = getDb();
    const res = db
      .prepare(
        `UPDATE open_loops SET status = 'stale', updated_at = datetime('now')
          WHERE agent_id = ? AND status = 'open' AND created_at < datetime('now', ?)`,
      )
      .run(agentId, `-${Math.max(1, Math.floor(thresholdDays))} days`);
    if (res.changes > 0) logger.info('open loops flipped to stale', { agentId, count: res.changes }, agentId);
    return res.changes;
  } catch (err) {
    logger.warn('markStaleLoops failed (non-fatal)', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return 0;
  }
}

export function getStaleLoops(agentId: string): OpenLoopRow[] {
  try {
    const db = getDb();
    return db
      .prepare(`SELECT * FROM open_loops WHERE agent_id = ? AND status = 'stale' ORDER BY created_at ASC`)
      .all(agentId) as OpenLoopRow[];
  } catch {
    return [];
  }
}

/** One-line-per-loop daily-brief section for stale loops, or null if none. */
export function buildStaleLoopsBriefSection(agentId: string): string | null {
  const stale = getStaleLoops(agentId);
  if (stale.length === 0) return null;
  const lines = stale.map((r) => {
    const party = convKeyToLabel(r.conv_key);
    const who = party ? ` (${party})` : '';
    return `- Still open, no answer: ${r.description}${who}, ask again or drop?`;
  });
  return `Open loops with no answer:\n${lines.join('\n')}`;
}

// ── Injection (human turns; open rows only) ──

export function getOpenLoopsForInjection(
  agentId: string,
  currentConvKey: string | null,
): { current: OpenLoopRow[]; other: OpenLoopRow[] } {
  try {
    const db = getDb();
    const rows = db
      .prepare(`SELECT * FROM open_loops WHERE agent_id = ? AND status = 'open' ORDER BY created_at ASC`)
      .all(agentId) as OpenLoopRow[];
    const current: OpenLoopRow[] = [];
    const other: OpenLoopRow[] = [];
    for (const r of rows) {
      if (currentConvKey && r.conv_key === currentConvKey) current.push(r);
      else other.push(r);
    }
    return { current, other: other.slice(0, CROSS_CONV_OVERFLOW_MAX) };
  } catch (err) {
    logger.warn('getOpenLoopsForInjection failed (non-fatal)', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return { current: [], other: [] };
  }
}

/** The compact numbered OPEN LOOPS block for the volatile lane, or null if none.
 *  Current-conversation loops first, then up to 3 cross-conversation loops labeled
 *  by party. Capped at ~600 chars. */
export function buildOpenLoopsInjection(agentId: string, currentConvKey: string | null): string | null {
  const { current, other } = getOpenLoopsForInjection(agentId, currentConvKey);
  if (current.length === 0 && other.length === 0) return null;

  const rendered: string[] = [];
  let n = 1;
  const render = (r: OpenLoopRow, crossConv: boolean): string => {
    const idp = r.id.slice(0, ID_PREFIX_LEN);
    const party = convKeyToLabel(r.conv_key) ?? 'unattributed';
    const age = relativeTimeAgoLocal(r.created_at);
    const marker = crossConv ? ' [other conversation]' : '';
    return `${n++}. [${idp}] ${r.description} (${party}, ${age})${marker}`;
  };
  for (const r of current) rendered.push(render(r, false));
  for (const r of other) rendered.push(render(r, true));

  let block = 'OPEN LOOPS (unresolved; resolve when answered):';
  for (const line of rendered) {
    if (block.length + 1 + line.length > INJECTION_MAX_CHARS) {
      block += '\n…';
      break;
    }
    block += `\n${line}`;
  }
  return block;
}

// ── Summary parsing (defensive) ──

export interface ParsedSummaryLoops {
  /** Open-loop entry descriptions (party-tag prefix retained as written). */
  openLoops: string[];
  /** RESOLVED / CLOSED entry descriptions. */
  resolved: string[];
  /** Summary text with the OPEN-LOOPS section removed. */
  strippedText: string;
  /** false only when parsing threw (caller then stores the summary unchanged). */
  parsedOk: boolean;
}

function parseResolvedClosed(text: string): string[] {
  const out: string[] = [];
  const re = /^[^\S\n]*(?:[-*•]\s*)?(?:\*\*)?\s*(?:RESOLVED|CLOSED)\b\s*:?\s*(?:\*\*)?\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const d = m[1].replace(/\*+$/, '').trim();
    if (d) out.push(d);
  }
  return out;
}

// Walk the lines after the OPEN-LOOPS header, collecting bullet entries until an
// END-OPEN-LOOPS marker, a new labeled section, or (for weak models that omit the
// terminator) the first non-bullet content line / a blank line after entries.
// Returns the entries and how many chars of the input were consumed as the block.
function walkLoopBlock(rest: string): { entries: string[]; consumed: number } {
  const entries: string[] = [];
  const lines = rest.split('\n');
  let consumed = 0;
  const isNoneEntry = (s: string): boolean => /^\(?\s*none\s*\)?\.?$/i.test(s);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    const advance = line.length + (i < lines.length - 1 ? 1 : 0); // +1 for the '\n' split removed

    if (/^(?:[-*•]\s*)?(?:\*\*)?\s*END[-\s]?OPEN[-\s]?LOOPS/i.test(t)) {
      consumed += advance; // consume the END line itself
      break;
    }
    if (/^(?:\*\*)?\s*(?:RESOLVED|DECIDED|CLOSED|DEFERRED)\b\s*:/i.test(t)) {
      break; // stop BEFORE this section; leave it in the summary
    }
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(t);
    if (bullet) {
      const e = bullet[1].trim();
      if (e && !isNoneEntry(e)) entries.push(e);
      consumed += advance;
      continue;
    }
    if (t === '') {
      consumed += advance;
      if (entries.length > 0) break; // a blank line ends the block once we have entries
      continue;
    }
    // A non-bullet content line. If it is the FIRST content line, a weak model may
    // have written the single loop without a bullet: take it, then stop. Otherwise
    // stop before it (do not swallow the rest of the summary).
    if (entries.length === 0) {
      if (!isNoneEntry(t)) entries.push(t);
      consumed += advance;
    }
    break;
  }
  return { entries, consumed };
}

/**
 * Parse a depth-0 summary for its fenced OPEN-LOOPS section and its RESOLVED/CLOSED
 * entries, and return the summary text with the OPEN-LOOPS section removed. The
 * section is bounded so it can never swallow the rest of the summary, and any throw
 * returns the original text unchanged with parsedOk=false.
 */
export function parseSummaryLoops(text: string): ParsedSummaryLoops {
  if (!text || !text.trim()) {
    return { openLoops: [], resolved: [], strippedText: text, parsedOk: true };
  }
  try {
    const resolved = parseResolvedClosed(text);

    const headerRe =
      /(^|\n)[^\S\n]*(?:[#>]+[^\S\n]*)?(?:\*\*)?[^\S\n]*OPEN[-\s]?LOOPS[^\S\n]*:?[^\S\n]*(?:\*\*)?[^\S\n]*(?=\n|$)/i;
    const hm = headerRe.exec(text);
    if (!hm) return { openLoops: [], resolved, strippedText: text, parsedOk: true };

    const headerStart = hm.index + (hm[1] ? hm[1].length : 0); // start of the header LINE
    const afterHeader = hm.index + hm[0].length;
    const rest = text.slice(afterHeader);

    const { entries, consumed } = walkLoopBlock(rest);
    const before = text.slice(0, headerStart);
    const after = text.slice(afterHeader + consumed);
    const strippedText = `${before}\n${after}`.replace(/\n{3,}/g, '\n\n').trim();

    return { openLoops: entries, resolved, strippedText, parsedOk: true };
  } catch (err) {
    logger.warn('parseSummaryLoops failed; caller should store the summary unchanged', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { openLoops: [], resolved: [], strippedText: text, parsedOk: false };
  }
}

/** Strip the OPEN-LOOPS section from a depth-0 summary WITHOUT upserting rows. Used
 *  by depth-0 consumers that are not the canonical leaf (continuity brief, rebuild)
 *  so the fenced section never leaks into stored/injected text. No-op if absent. */
export function stripOpenLoopsSection(text: string): string {
  try {
    const parsed = parseSummaryLoops(text);
    return parsed.parsedOk && parsed.strippedText ? parsed.strippedText : text;
  } catch {
    return text;
  }
}

// ── Compaction ingest (leaf path) ──

/** Party-label -> conv_key map from a summarized chunk, using the SAME party tags
 *  the summarizer sees, plus the conv-key-derived label so self rows resolve. Only
 *  rows with a resolvable conv_key contribute. Also returns the chunk's most common
 *  conv_key as the attribution fallback. */
function partyMapFromChunk(chunk: Message[]): { map: Map<string, string>; defaultKey: string | null } {
  const map = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const m of chunk) {
    const key = m.convKey;
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const label of [summaryPartyTag(m), convKeyToLabel(key)]) {
      if (!label) continue;
      const norm = label.toLowerCase().trim();
      if (norm.length >= 3 && !map.has(norm)) map.set(norm, key);
    }
  }
  let defaultKey: string | null = null;
  let best = 0;
  for (const [k, c] of counts) {
    if (c > best) {
      best = c;
      defaultKey = k;
    }
  }
  return { map, defaultKey };
}

/** Best-effort attribute an open-loop entry to a conv_key via its party label
 *  (longest matching label wins), falling back to the chunk's dominant conv_key. */
function attributeLoop(entry: string, map: Map<string, string>, defaultKey: string | null): string | null {
  const lower = entry.toLowerCase();
  let bestKey: string | null = null;
  let bestLen = 0;
  for (const [label, key] of map) {
    if (lower.includes(label) && label.length > bestLen) {
      bestKey = key;
      bestLen = label.length;
    }
  }
  return bestKey ?? defaultKey;
}

export interface IngestParams {
  agentId: string;
  summaryText: string;
  chunk: Message[];
}

/**
 * Parse a freshly generated depth-0 (leaf) summary for its OPEN-LOOPS +
 * RESOLVED/CLOSED sections, upsert/resolve structured rows, and return the summary
 * text with the OPEN-LOOPS section stripped. On parse failure the original text is
 * returned unchanged (defensive). Never throws.
 */
export function ingestSummaryOpenLoops(params: IngestParams): string {
  const { agentId, summaryText, chunk } = params;
  const parsed = parseSummaryLoops(summaryText);
  if (!parsed.parsedOk) {
    logger.info('open-loops parse failed; storing summary unchanged', { agentId }, agentId);
    return summaryText;
  }
  try {
    const { map, defaultKey } = partyMapFromChunk(chunk);
    const sourceMessageId = chunk.length > 0 ? chunk[chunk.length - 1].id : null;
    for (const entry of parsed.openLoops) {
      const convKey = attributeLoop(entry, map, defaultKey);
      insertOpenLoop({ agentId, convKey, description: entry, sourceMessageId });
    }
    if (parsed.resolved.length > 0) resolveMatchingLoops(agentId, parsed.resolved);
  } catch (err) {
    logger.warn('ingestSummaryOpenLoops upsert failed (non-fatal)', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  // Guard against handing an empty body to the summary store if the whole summary
  // was (improbably) nothing but the loops section.
  return parsed.strippedText && parsed.strippedText.length >= 20 ? parsed.strippedText : summaryText;
}

// ── Local time helper (kept dependency-light; mirrors outbound-ledger) ──

function relativeTimeAgoLocal(sqliteUtc: string): string {
  const ms = Date.parse(sqliteUtc.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return 'recently';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return 'just now';
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
