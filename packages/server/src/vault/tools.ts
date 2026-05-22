// ════════════════════════════════════════
// Vault Tools: vault_remember, vault_search, vault_forget
// Agent-callable tools for interacting with the vault
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { createEntry, semanticSearch, markObsolete, getEntry, updateEntry, listEntries } from './store.js';

const logger = createLogger('vault-tools');

// ── vault_remember ──
//
// Goals (per user direction): every entry should be a SUMMARY of source
// content (not a transcription) and should have a REASON to exist. We
// don't reject entries by length, prose shape, or technique overlap —
// the prompt sets the bar, the engine just helps quietly:
//   - Strip common narrative cruft so transcribed-feeling entries lose
//     their filler before saving.
//   - Surface near-duplicate alerts so the agent sees when it's drifting.
//   - Surface technique-overlap as info (not a block).

// Common bloat-phrase patterns the engine strips silently. These are
// narrative fillers the model writes that carry no information ("the
// user mentioned that…", "during a conversation on…"). Conservative by
// design — only patterns that are unambiguous filler.
const BLOAT_STRIP_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Date prefix — we already auto-prepend [YYYY-MM-DD], so a duplicate
  // "On YYYY-MM-DD," or "During a conversation on YYYY-MM-DD," is redundant.
  { re: /\b[Oo]n \d{4}-\d{2}-\d{2}[,:]?\s+/g, replacement: '' },
  { re: /\b[Dd]uring (?:a|the) conversation on \d{4}-\d{2}-\d{2}[,:]?\s+/g, replacement: '' },
  // "The user (mentioned|said|noted|stated|indicated) (that)?"
  { re: /\b[Tt]he user (?:mentioned|said|noted|stated|indicated|told (?:[Kk]evin|me|us)|expressed) (?:that )?/g, replacement: '' },
  // "It was (determined|noted|observed|found|decided) that"
  { re: /\b[Ii]t was (?:determined|noted|observed|found|decided|established|confirmed) that\s+/g, replacement: '' },
  // Narrative scaffolding
  { re: /\b(?:[Ll]ooking back|[Gg]oing forward|[Mm]oving forward|[Ii]n summary|[Tt]o summarize)[,:]\s+/g, replacement: '' },
  // Collapse whitespace introduced by stripping
  { re: /[ \t]{2,}/g, replacement: ' ' },
  { re: /\n{3,}/g, replacement: '\n\n' },
];

function stripBloatPhrases(content: string): { stripped: string; charsRemoved: number } {
  const before = content;
  let after = content;
  for (const { re, replacement } of BLOAT_STRIP_PATTERNS) {
    after = after.replace(re, replacement);
  }
  after = after.trim();
  return { stripped: after, charsRemoved: before.length - after.length };
}

export async function executeVaultRemember(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string> {
  let content = args.content as string;
  const type = args.type as string;
  const tags = (args.tags as string[]) ?? [];
  const pin = (args.pin as boolean) ?? false;
  const permanent = (args.permanent as boolean) ?? false;
  const verbatim = (args.verbatim as boolean) ?? false;

  if (!content) return 'Error: content is required.';
  if (!type) return 'Error: type is required (fact, preference, decision, procedure, relationship, event, or note).';

  const validTypes = ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'];
  if (!validTypes.includes(type)) {
    return `Error: type must be one of: ${validTypes.join(', ')}`;
  }

  // ── Verbatim mode ──
  // When the user explicitly says "remember that X", "always Y", "never Z",
  // etc., the agent passes verbatim: true so the engine preserves the
  // instruction exactly: no bloat-strip, no date prefix, no compression.
  // The point of the entry is to capture the user's words faithfully.
  let charsRemoved = 0;
  if (!verbatim) {
    // Strip common narrative cruft silently.
    const result = stripBloatPhrases(content);
    content = result.stripped;
    charsRemoved = result.charsRemoved;

    // Auto-prepend today's date if the content doesn't already start with a
    // date stamp. Keeps every entry temporally anchored.
    if (!/^\[?\d{4}-\d{2}/.test(content)) {
      const dateStr = new Date().toISOString().split('T')[0];
      content = `[${dateStr}] ${content}`;
    }
  }

  // Get agent name
  const db = getDb();
  const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;

  try {
    const entry = await createEntry({
      agentId,
      agentName: agent?.name,
      type,
      content,
      tags,
      isPinned: pin,
      isPermanent: permanent,
      source: 'agent',
    });

    const flags: string[] = [];
    if (pin) flags.push('pinned');
    if (permanent) flags.push('permanent');
    const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';

    // Near-duplicate alert (informational, never blocking). The 0.92
    // auto-supersede path in createEntry handles near-identical paraphrases;
    // this catches the 0.78–0.92 zone where two entries are about the
    // same topic but worded differently. Helps the agent self-correct
    // toward dedup without us forcing it.
    let nearDupNote = '';
    try {
      const hits = await semanticSearch(content, { limit: 3 });
      const sameSubject = hits.filter(h => h.id !== entry.id && h.similarity >= 0.78 && h.similarity < 0.92);
      if (sameSubject.length > 0) {
        const top = sameSubject[0];
        nearDupNote = `\n\nFYI: similar entry already exists — "${top.content.slice(0, 80)}…" (id ${top.id}, similarity ${top.similarity.toFixed(2)}). Consider vault_forget on the older one if yours supersedes it.`;
      }
    } catch { /* best effort */ }

    const compressionNote = charsRemoved > 0
      ? `\n(Engine stripped ${charsRemoved} chars of narrative filler before saving.)`
      : '';

    return `Remembered [${type}]${flagStr}: "${entry.content.slice(0, 120)}${entry.content.length > 120 ? '…' : ''}"\nEntry ID: ${entry.id}${nearDupNote}${compressionNote}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('vault_remember failed', { error: msg }, agentId);
    return `Error saving to vault: ${msg}`;
  }
}

// ── vault_search ──

export async function executeVaultSearch(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const query = args.query as string;
  const type = args.type as string | undefined;
  // Phase 3.5 (2026-05-04) — default limit lowered from 10 to 5 to keep
  // search results compact. The agent can still pass a higher limit when
  // they genuinely want more matches.
  const limit = (args.limit as number) ?? 5;
  // v2.7.2 — explicit mode. 'semantic' (default) uses embedding similarity
  // which is great for conceptual recall but blind to exact strings —
  // searching for an unusual literal substring like "corp erp.in" against
  // the user's actual domain "cornerp.in" returns nothing relevant because
  // both embed to the same generic "email domain" cluster. 'exact' uses
  // SQL LIKE on the content field — use it for debugging memory poisoning
  // or finding entries that contain a specific phrase verbatim.
  const mode = (args.mode as 'semantic' | 'exact' | undefined) ?? 'semantic';

  if (!query) return 'Error: query is required.';

  try {
    const SNIPPET_CHARS = 200;

    if (mode === 'exact') {
      const rows = listEntries({ search: query, type, limit });
      if (rows.length === 0) {
        return `No vault entries contain the exact substring "${query}".`;
      }
      const lines = rows.map((r, i) => {
        const flags: string[] = [];
        if (r.isPinned) flags.push('pinned');
        if (r.isPermanent) flags.push('permanent');
        const flagStr = flags.length > 0 ? ` {${flags.join(',')}}` : '';
        // Show a snippet anchored on the match so the agent can see context.
        const idx = r.content.toLowerCase().indexOf(query.toLowerCase());
        const start = idx === -1 ? 0 : Math.max(0, idx - 60);
        const end = idx === -1 ? SNIPPET_CHARS : Math.min(r.content.length, idx + query.length + 140);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < r.content.length ? '…' : '';
        const snippet = prefix + r.content.slice(start, end) + suffix;
        return `${i + 1}. [${r.type}]${flagStr} ${snippet}\n   ID: ${r.id} | Created: ${r.createdAt}`;
      });
      return `Found ${rows.length} vault entr${rows.length === 1 ? 'y' : 'ies'} containing "${query}" (exact match):\n\n${lines.join('\n\n')}\n\nUse vault_expand(entry_id="…") for full content, vault_update to correct, vault_forget to mark obsolete.`;
    }

    const results = await semanticSearch(query, { limit, type });

    if (results.length === 0) {
      return 'No matching memories found in the vault. If you are looking for a specific literal string (e.g. an exact name or typo), retry with mode: "exact".';
    }

    // Phase 3.5 — per-entry snippet cap at 200 chars. Full content is
    // available on demand via vault_expand(entry_id). Keeps search results
    // bounded so a 5-result query never blows past ~2K tokens.
    const lines = results.map((r, i) => {
      const flags: string[] = [];
      if (r.isPinned) flags.push('pinned');
      if (r.isPermanent) flags.push('permanent');
      const flagStr = flags.length > 0 ? ` {${flags.join(',')}}` : '';
      const conf = r.confidence < 1.0 ? ` (confidence: ${r.confidence.toFixed(1)})` : '';
      const snippet =
        r.content.length > SNIPPET_CHARS
          ? r.content.slice(0, SNIPPET_CHARS) + '…'
          : r.content;
      return `${i + 1}. [${r.type}]${flagStr}${conf} ${snippet}\n   ID: ${r.id} | Similarity: ${r.similarity.toFixed(2)} | Created: ${r.createdAt}`;
    });

    const truncatedCount = results.filter((r) => r.content.length > SNIPPET_CHARS).length;
    const expandHint =
      truncatedCount > 0
        ? `\n\n${truncatedCount} entry${truncatedCount === 1 ? '' : 'ies'} truncated. Use vault_expand(entry_id="…") for the full content.`
        : '';

    return `Found ${results.length} vault memor${results.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n\n')}${expandHint}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('vault_search failed', { error: msg }, agentId);
    return `Error searching vault: ${msg}`;
  }
}

// ── vault_update ──
// v2.7.2 — atomic content replacement for an existing vault entry. Pre-
// existing flow required vault_forget + vault_remember which (a) lost the
// stable entry ID, (b) created a window where both old and new lived, and
// (c) tempted the agent to skip the forget step. updateEntry already
// existed in the store; this just exposes it as an agent tool with a
// required reason for auditability.
export async function executeVaultUpdate(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const entryId = args.entry_id as string;
  const newContent = args.new_content as string;
  const reason = args.reason as string;

  if (!entryId) return 'Error: entry_id is required.';
  if (!newContent) return 'Error: new_content is required.';
  if (!reason) return 'Error: reason is required (explain what changed and why).';

  const existing = getEntry(entryId);
  if (!existing) return `Error: Vault entry "${entryId}" not found.`;
  if (existing.isObsolete) {
    return `Error: Entry "${entryId}" is already marked obsolete. Use vault_remember to create a fresh entry instead.`;
  }

  const updated = updateEntry(entryId, { content: newContent });
  if (!updated) return `Error: Failed to update vault entry "${entryId}".`;

  logger.info('Vault entry updated', { id: entryId, reason, agentId });
  return `Updated [${updated.type}] entry ${entryId}.\nReason: ${reason}\nNew content (first 200 chars): "${updated.content.slice(0, 200)}${updated.content.length > 200 ? '…' : ''}"`;
}

// Phase 3.5 (2026-05-04) — vault_expand: return the full content of one
// specific vault entry. Pairs with vault_search's compact-by-default
// snippets — agents skim search results, then expand the few that matter.
export function executeVaultExpand(
  agentId: string,
  args: Record<string, unknown>,
): string {
  const entryId = args.entry_id as string | undefined;
  if (!entryId) return 'Error: entry_id is required.';
  const entry = getEntry(entryId);
  if (!entry) return `Error: Vault entry "${entryId}" not found.`;

  const flags: string[] = [];
  if (entry.isPinned) flags.push('pinned');
  if (entry.isPermanent) flags.push('permanent');
  if (entry.isObsolete) flags.push('obsolete');
  const flagStr = flags.length > 0 ? ` {${flags.join(',')}}` : '';

  return (
    `[${entry.type}]${flagStr}\n` +
    `ID: ${entry.id}\n` +
    `Created: ${entry.createdAt}\n` +
    (entry.tags && entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}\n` : '') +
    `\n${entry.content}`
  );
}

// ── vault_forget ──

export function executeVaultForget(
  agentId: string,
  args: Record<string, unknown>,
): string {
  const entryId = args.entry_id as string;
  const reason = args.reason as string;

  if (!entryId) return 'Error: entry_id is required.';
  if (!reason) return 'Error: reason is required (explain why this is no longer accurate).';

  // Check classification -- only sensei can forget
  const db = getDb();
  const agent = db.prepare('SELECT classification FROM agents WHERE id = ?').get(agentId) as { classification: string } | undefined;
  if (agent?.classification !== 'sensei') {
    return 'Error: Only Sensei agents can mark vault entries as obsolete.';
  }

  const entry = getEntry(entryId);
  if (!entry) return `Error: Vault entry "${entryId}" not found.`;
  if (entry.isObsolete) return `Entry "${entryId}" is already marked as obsolete.`;

  markObsolete(entryId, reason);
  return `Marked as obsolete: [${entry.type}] "${entry.content.slice(0, 80)}..."\nReason: ${reason}`;
}
