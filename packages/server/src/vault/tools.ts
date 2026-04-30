// ════════════════════════════════════════
// Vault Tools: vault_remember, vault_search, vault_forget
// Agent-callable tools for interacting with the vault
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { createEntry, semanticSearch, markObsolete, getEntry } from './store.js';

const logger = createLogger('vault-tools');

// ── vault_remember ──

// Soft length budgets per type. Real-world entries that drift well past
// these are almost always narrative bloat — debugging session retellings,
// chronological recaps, "root cause was X and the fix was Y" stories.
// We don't reject (the agent's next call would just retry blindly), but
// we surface a strongly-worded compression hint in the success message
// so the *next* vault_remember from this agent runs tighter.
const TYPE_SOFT_BUDGET_CHARS: Record<string, number> = {
  fact: 200,
  preference: 200,
  note: 250,
  relationship: 250,
  decision: 350,
  procedure: 400,
  event: 350,
};
// Above this, the entry is almost certainly a narrative dump that should
// have been multiple smaller entries (or no entry at all). We still save
// it, but the response leads with a hard correction.
const HARD_BLOAT_CHARS = 1000;

export async function executeVaultRemember(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string> {
  let content = args.content as string;
  const type = args.type as string;
  const tags = (args.tags as string[]) ?? [];
  const pin = (args.pin as boolean) ?? false;
  const permanent = (args.permanent as boolean) ?? false;

  if (!content) return 'Error: content is required.';
  if (!type) return 'Error: type is required (fact, preference, decision, procedure, relationship, event, or note).';

  // Auto-prepend today's date if the content doesn't already start with a
  // date stamp. This ensures every vault entry is temporally anchored so
  // agents can judge its age and relevance.
  if (!/^\[?\d{4}-\d{2}/.test(content)) {
    const dateStr = new Date().toISOString().split('T')[0];
    content = `[${dateStr}] ${content}`;
  }

  const validTypes = ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'];
  if (!validTypes.includes(type)) {
    return `Error: type must be one of: ${validTypes.join(', ')}`;
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

    // Length-based push-back. Telegraphic shorthand is the goal; long
    // entries dilute search results and burn retrieval budget.
    const budget = TYPE_SOFT_BUDGET_CHARS[type] ?? 300;
    let warning = '';
    if (entry.content.length > HARD_BLOAT_CHARS) {
      warning = `\n\n⚠ This entry is ${entry.content.length} chars — that's narrative bloat, not a memory. Vault entries should be telegraphic shorthand (≤${budget} chars for type "${type}"). Either you're writing a debugging recap that doesn't belong here, or you're storing a story when one fact would suffice. NEXT entries: lead with the noun. Cut every word that doesn't carry information. If you can't say it in ${budget} chars, it's probably not vault-worthy.`;
    } else if (entry.content.length > budget) {
      warning = `\n\nNote: this entry is ${entry.content.length} chars; soft target for type "${type}" is ≤${budget}. Compress next time — strip narrative ("initially failed because…", "root cause was…", "the fix was…") and lead with the durable fact.`;
    }

    return `Remembered [${type}]${flagStr}: "${entry.content.slice(0, 100)}${entry.content.length > 100 ? '...' : ''}"\nEntry ID: ${entry.id}${warning}`;
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
