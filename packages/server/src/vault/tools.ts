// ════════════════════════════════════════
// Vault Tools: vault_remember, vault_search, vault_forget
// Agent-callable tools for interacting with the vault
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { createEntry, semanticSearch, markObsolete, getEntry } from './store.js';

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
  const limit = (args.limit as number) ?? 10;

  if (!query) return 'Error: query is required.';

  try {
    const results = await semanticSearch(query, { limit, type });

    if (results.length === 0) {
      return 'No matching memories found in the vault.';
    }

    const lines = results.map((r, i) => {
      const flags: string[] = [];
      if (r.isPinned) flags.push('pinned');
      if (r.isPermanent) flags.push('permanent');
      const flagStr = flags.length > 0 ? ` {${flags.join(',')}}` : '';
      const conf = r.confidence < 1.0 ? ` (confidence: ${r.confidence.toFixed(1)})` : '';
      return `${i + 1}. [${r.type}]${flagStr}${conf} ${r.content}\n   ID: ${r.id} | Similarity: ${r.similarity.toFixed(2)} | Created: ${r.createdAt}`;
    });

    return `Found ${results.length} vault memor${results.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n\n')}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('vault_search failed', { error: msg }, agentId);
    return `Error searching vault: ${msg}`;
  }
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
