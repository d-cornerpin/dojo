// Vault tools: vault_remember, vault_search, vault_update, vault_get, vault_forget.

import { getDb } from '../db/connection.js';
import { TECHNIQUE_FRESH_SENTINEL } from '@dojo/shared';
import { createLogger } from '../logger.js';
import { isPrimaryAgent } from '../config/platform.js';
import { createEntry, semanticSearch, findNearDuplicateEntry, markObsolete, getEntry, updateEntry, isOverEntryLimit, AGENT_ENTRY_CUT_NOTE, listEntriesBounded, lastSemanticSearchWindow, formatCitationSuffix, resolveRecallScope, OWNER_VAULT_AGENT_ID } from './store.js';
import { searchUnfiledArchives, UNFILED_ARCHIVE_LABEL, type UnfiledArchiveSnippet } from './retrieval.js';
import { recordVaultUse } from './store.js';
import { isObligationNote, obligationTags } from '../work/obligation-memory.js';
import { detectCredentialContent } from './credential-gate.js';

/** The kinds a saved fact may have. The agent tool and the dashboard check against this one list. */
export const VAULT_ENTRY_TYPES: readonly string[] = ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'];

const logger = createLogger('vault-tools');

// ── vault_remember ──
// Entries should be SUMMARIES with a reason to exist: the engine strips filler, then bounces over-length,
// prose-shaped and near-duplicate entries with a corrective error.

// Narrative filler phrases the engine strips silently; only unambiguous patterns.
const BLOAT_STRIP_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // The engine auto-prepends [YYYY-MM-DD], so a duplicate date prefix is redundant.
  { re: /\b[Oo]n \d{4}-\d{2}-\d{2}[,:]?\s+/g, replacement: '' },
  { re: /\b[Dd]uring (?:a|the) conversation on \d{4}-\d{2}-\d{2}[,:]?\s+/g, replacement: '' },
  { re: /\b[Tt]he user (?:mentioned|said|noted|stated|indicated|told (?:me|us)|expressed) (?:that )?/g, replacement: '' },
  { re: /\b[Ii]t was (?:determined|noted|observed|found|decided|established|confirmed) that\s+/g, replacement: '' },
  { re: /\b(?:[Ll]ooking back|[Gg]oing forward|[Mm]oving forward|[Ii]n summary|[Tt]o summarize)[,:]\s+/g, replacement: '' },
  { re: /[ \t]{2,}/g, replacement: ' ' },
  { re: /\n{3,}/g, replacement: '\n\n' },
];

function stripBloatPhrases(content: string, selfName: string | null): { stripped: string; charsRemoved: number } {
  const before = content;
  let after = content;
  // "The user told <own name>" is filler too; the name comes from the DB so none is in the patterns above.
  // It runs first so the last two patterns collapse the whitespace it leaves.
  if (selfName && /^[A-Za-z][A-Za-z0-9 _-]*$/.test(selfName)) {
    const esc = selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    after = after.replace(new RegExp(`\\b[Tt]he user told ${esc} (?:that )?`, 'gi'), '');
  }
  for (const { re, replacement } of BLOAT_STRIP_PATTERNS) {
    after = after.replace(re, replacement);
  }
  after = after.trim();
  return { stripped: after, charsRemoved: before.length - after.length };
}

// Per-type length caps from the Dreamer's SOUL (keep its wording in sync). Enforced only on the
// vault_remember tool path (executeVaultRemember), which returns a corrective error; direct writers are
// not gated. Measured on content only: the date prefix is added after this gate.
const VAULT_ENTRY_CHAR_CAPS: Record<string, number> = {
  fact: 150,
  preference: 150,
  note: 150,
  relationship: 150,
  decision: 250,
  event: 250,
  procedure: 250,
};
const DEFAULT_ENTRY_CHAR_CAP = 150;

// Exemption: user-explicit standing instructions ("remember that", "always", "never", "from now on")
// are saved as-is. Matched conservatively; a borderline entry saving uncompressed is the safe direction.
const STANDING_INSTRUCTION_RE =
  /\b(?:remember (?:that|to|this)|i want you to remember|make sure you (?:remember|always|never)|always|never|from now on|going forward|from this point on|do not ever)\b/i;

function isStandingInstruction(content: string): boolean {
  return STANDING_INSTRUCTION_RE.test(content);
}

// Sentence terminators: a '.', '!' or '?' followed by whitespace or end of string.
function countSentenceTerminators(content: string): number {
  return (content.match(/[.!?](?:\s|$)/g) ?? []).length;
}

// Prose-shape bounce: only when the entry is over half its type cap AND has 3+ sentence terminators. No
// subject-verb heuristic: it false-positives on telegraphic lines that begin with a pronoun.
function isProseShaped(content: string, cap: number, terminators: number): boolean {
  if (content.length <= cap / 2) return false;
  return terminators >= 3;
}

// The compression contract, one place for vault_remember and vault_update: the per-type cap and the
// prose-shape bounce. Returns the refusal text, or null when the content fits.
function compressionRefusal(type: string, content: string, tool: 'vault_remember' | 'vault_update'): string | null {
  const cap = VAULT_ENTRY_CHAR_CAPS[type] ?? DEFAULT_ENTRY_CHAR_CAP;
  const retry = tool === 'vault_remember'
    ? 'then call vault_remember again. (If the person you are talking to told you to remember something word-for-word, pass verbatim: true to save it exactly.) Do not report this as saved or stored; nothing was written.'
    : 'then call vault_update again. Do not report this as changed; nothing was written.';
  if (content.length > cap) {
    return (
      `Too long for a [${type}] vault entry: ${content.length} chars, cap is ${cap}. ` +
      `Vault entries are compressed shorthand, not prose. Rewrite it shorter: lead with the noun, ` +
      `cut filler words, keep only the durable fact (example shape: "Tunnel: Cloudflare named. Reason: self-hosted integration."), ` +
      retry
    );
  }
  const terminators = countSentenceTerminators(content);
  if (isProseShaped(content, cap, terminators)) {
    return (
      `Reads like narrative prose for a [${type}] vault entry (${terminators} sentences). ` +
      `Vault entries are one telegraphic line, not a story. Rewrite it as a single compressed line: lead with the noun, ` +
      `drop the "the user/we/I did X" framing, keep only the durable fact under ${cap} chars, ` +
      retry
    );
  }
  return null;
}

// Builds the citation JSON from flat params (source_ref, optional source_page/source_section): the floor
// model fills flat strings far more reliably than a nested object. `kind` is derived here; null without
// source_ref.
function buildCitationJson(args: Record<string, unknown>): string | null {
  const rawRef = typeof args.source_ref === 'string' ? args.source_ref.trim() : '';
  if (!rawRef) return null;
  const kind: 'url' | 'file' = /^https?:\/\//i.test(rawRef) ? 'url' : 'file';
  const citation: { kind: 'url' | 'file'; ref: string; page?: number; section?: string } = { kind, ref: rawRef };
  // Floor models sometimes send numbers as strings; coerce defensively.
  let page: number | undefined;
  if (typeof args.source_page === 'number') page = args.source_page;
  else if (typeof args.source_page === 'string' && args.source_page.trim() !== '') {
    const n = Number(args.source_page);
    if (Number.isFinite(n)) page = n;
  }
  if (page !== undefined && Number.isFinite(page)) citation.page = Math.trunc(page);
  const section = typeof args.source_section === 'string' ? args.source_section.trim() : '';
  if (section) citation.section = section;
  return JSON.stringify(citation);
}

export async function executeVaultRemember(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string> {
  let content = args.content as string;
  const type = args.type as string;
  const tags = (args.tags as string[]) ?? [];
  const pin = (args.pin as boolean) ?? false;
  const permanent = (args.permanent as boolean | undefined) ?? (pin && args.verbatim === true);
  const verbatim = (args.verbatim as boolean) ?? false;
  // After a near-duplicate bounce the model sets this to assert the fact is different, overriding the bounce.
  const distinct = (args.distinct as boolean) ?? false;

  if (!content) return 'Error: content is required.';
  if (!type) return 'Error: type is required (fact, preference, decision, procedure, relationship, event, or note).';

  if (!VAULT_ENTRY_TYPES.includes(type)) {
    return `Error: type must be one of: ${VAULT_ENTRY_TYPES.join(', ')}`;
  }

  // Refuse technique text: techniques mutate on disk and prior reads are stubbed after one turn, so a vaulted
  // copy would freeze a stale version. Detected by the sentinel every technique result carries.
  if (content.includes(TECHNIQUE_FRESH_SENTINEL)) {
    return (
      `Refused: this content looks like it came from a technique_read / use_technique ` +
      `response (contains the fresh-read sentinel). Techniques mutate on disk and the ` +
      `engine stubs prior reads after 1 turn so agents always work from the current ` +
      `version. Vaulting technique text would re-introduce the staleness this is ` +
      `built to prevent. If you need to remember something ABOUT applying the ` +
      `technique (a decision, a parameter you chose, a result), vault that, not the ` +
      `technique body. Re-call technique_read whenever you need the steps again. ` +
      `Do not report this as saved or stored; nothing was written.`
    );
  }

  const credentialPattern = detectCredentialContent(content);
  if (credentialPattern) {
    return (
      `Refused: this content looks like it contains a credential (matched pattern: ${credentialPattern}). ` +
      `Credentials, API keys, tokens, passwords, and other authentication material do NOT belong in the vault. ` +
      `Use credential_add(service_name, credentials, description) instead, values are encrypted at rest, never decay, ` +
      `never appear in vault_search or Dreamer summaries, and are read on-demand at API-call time via credential_get. ` +
      `If you are saving a NOTE about a credential (e.g. "user prefers OAuth over PATs for GitHub"), rephrase to remove the ` +
      `credential-shaped substring and try again. ` +
      `Do not report this as saved or stored; nothing was written.`
    );
  }

  // Refuse obligations: a promise is kept or dropped, and `work(kind='commitment')` is the ledger that knows.
  // Frozen in the vault it would be recalled as still owed, and recall keeps it alive (hygiene arms are keyed
  // on retrieval_count = 0). A commitment's join token is one by name; any other note is judged by `isObligationNote`.
  if (obligationTags(content).length > 0 || await isObligationNote(agentId, content)) {
    return (
      `Refused: this reads as an OBLIGATION rather than a memory. ` +
      `A promise changes state — it gets kept or dropped — and the vault has no way to find out: ` +
      `it does not age, it never enters your OPEN WORK block, and nothing will ever surface it as ` +
      `still owed. Worse, recall keeps it alive: vault hygiene only expires entries nobody reads. ` +
      `Record it as work instead: work_open(kind="commitment", description="...") puts it in your ` +
      `OPEN WORK block until you close it with work_close_request. ` +
      `If you meant to save a FACT about the situation ("the contractor's address is still unknown"), rephrase ` +
      `it as the fact and try again. ` +
      `Do not report this as saved or stored; nothing was written.`
    );
  }

  // Verbatim mode keeps the user's exact words: no bloat-strip, no date prefix, no compression.
  let charsRemoved = 0;
  // Classify standing instructions on the content AS WRITTEN: "Going forward," is both a trigger phrase and a
  // scaffolding phrase the strip removes.
  const standingAsWritten = isStandingInstruction(content);
  if (!verbatim && !standingAsWritten) {
    // Strip narrative cruft before measuring length, so this runs before the cap gate below.
    const selfRow = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name?: string } | undefined;
    const result = stripBloatPhrases(content, selfRow?.name ?? null);
    content = result.stripped;
    charsRemoved = result.charsRemoved;
  }

  // Compression contract on the tool path: per-type caps and a prose-shape bounce. Exempt: verbatim,
  // standing instructions, and owner-authored entries (agent_id === OWNER_VAULT_AGENT_ID).
  const exemptFromCompression =
    verbatim || agentId === OWNER_VAULT_AGENT_ID || standingAsWritten;
  if (!exemptFromCompression) {
    const refusal = compressionRefusal(type, content, 'vault_remember');
    if (refusal) return refusal;
  }

  // Prepend today's date unless present (non-verbatim only), after the cap gate so it is never counted.
  if (!verbatim && !/^\[?\d{4}-\d{2}/.test(content)) {
    const dateStr = new Date().toISOString().split('T')[0];
    content = `[${dateStr}] ${content}`;
  }

  // Source citation, built from content-free params so it never affects the cap gate above.
  const citation = buildCitationJson(args);

  // Pre-save near-duplicate bounce: refuse before createEntry, name the existing entry, and steer to
  // vault_update (or distinct: true). Same exemptions as the compression gate. Direct createEntry callers
  // (Dreamer, extraction) never bounce, and the >= 0.92 auto-supersede inside createEntry is separate.
  if (!exemptFromCompression && !distinct) {
    const near = await findNearDuplicateEntry(content, agentId);
    if (near) {
      return (
        `Near-duplicate: a similar [${near.type}] entry already exists, ` +
        `"${near.content.slice(0, 120)}${near.content.length > 120 ? '…' : ''}" ` +
        `(id ${near.id}, similarity ${near.similarity.toFixed(2)}). Nothing was saved. ` +
        `If your new fact CORRECTS or REPLACES that entry, call ` +
        `vault_update(entry_id="${near.id}", new_content=…, reason=…). ` +
        `If it is a genuinely DIFFERENT fact that only sounds similar, re-call ` +
        `vault_remember with distinct: true. ` +
        `Do not report this as saved or stored; nothing was written.`
      );
    }
  }

  const db = getDb();
  const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;

  try {
    const cutNote = isOverEntryLimit(content) ? `\n${AGENT_ENTRY_CUT_NOTE}` : '';
    const entry = await createEntry({
      agentId,
      agentName: agent?.name,
      type,
      content,
      tags,
      isPinned: pin,
      isPermanent: permanent,
      source: 'agent',
      citation,
      distinct,
    });

    const flags: string[] = [];
    if (pin) flags.push('pinned');
    if (permanent) flags.push('permanent');
    const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';


    const compressionNote = charsRemoved > 0
      ? `\n(Engine stripped ${charsRemoved} chars of narrative filler before saving.)`
      : '';

    // Echo the captured source so the agent can confirm it stuck.
    const citationSuffix = formatCitationSuffix(entry.citation);

    return `Remembered [${type}]${flagStr}: "${entry.content.slice(0, 120)}${entry.content.length > 120 ? '…' : ''}"${citationSuffix}\nEntry ID: ${entry.id}${compressionNote}${cutNote}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('vault_remember failed', { error: msg }, agentId);
    return `Error saving to vault: ${msg}`;
  }
}


// Formats snippets from the just-archived, unfiled session for a vault_search result, under the same label as
// context injection. No entry IDs: there is nothing to vault_get yet.
function formatUnfiledBridgeForSearch(snippets: UnfiledArchiveSnippet[]): string {
  const lines = snippets.map((s, i) => `${i + 1}. [${s.latestAt}] ${s.text}`);
  return `${UNFILED_ARCHIVE_LABEL}\n\n${lines.join('\n\n')}`;
}

export async function executeVaultSearch(
  agentId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const query = args.query as string;
  const type = args.type as string | undefined;
  const limit = (args.limit as number) ?? 5;
  // 'semantic' (default) is blind to exact strings; 'exact' is SQL LIKE on content, for a literal phrase.
  const mode = (args.mode as 'semantic' | 'exact' | undefined) ?? 'semantic';

  if (!query) return 'Error: query is required.';

  try {
    const SNIPPET_CHARS = 200;

    if (mode === 'exact') {
      // Scoped to the caller's recall scope (resolveRecallScope). Runs on the reader pool: a leading-wildcard
      // LIKE cannot use an index, so it must not scan on the thread that serves HTTP.
      const rows = await listEntriesBounded({ search: query, type, limit, agentId, includeOwnerScope: true });
      // Exact mode also searches still-unfiled archives, by substring.
      const bridge = searchUnfiledArchives(agentId, query, { mode: 'substring' });
      if (rows.length === 0) {
        // Nothing distilled yet, but the fact may sit in a just-archived session: surface it.
        if (bridge.length > 0) {
          return `No distilled vault entries contain "${query}" yet, but the just-archived previous session does:\n\n${formatUnfiledBridgeForSearch(bridge)}`;
        }
        return `No vault entries contain the exact substring "${query}".`;
      }
      const lines = rows.map((r, i) => {
        const flags: string[] = [];
        if (r.isPinned) flags.push('pinned');
        if (r.isPermanent) flags.push('permanent');
        const flagStr = flags.length > 0 ? ` {${flags.join(',')}}` : '';
        const idx = r.content.toLowerCase().indexOf(query.toLowerCase());
        const start = idx === -1 ? 0 : Math.max(0, idx - 60);
        const end = idx === -1 ? SNIPPET_CHARS : Math.min(r.content.length, idx + query.length + 140);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < r.content.length ? '…' : '';
        const snippet = prefix + r.content.slice(start, end) + suffix;
        return `${i + 1}. [${r.type}]${flagStr} ${snippet}${formatCitationSuffix(r.citation)}\n   ID: ${r.id} | Created: ${r.createdAt}`;
      });
      const bridgeSection = bridge.length > 0 ? `\n\n${formatUnfiledBridgeForSearch(bridge)}` : '';
      recordVaultUse(rows.map((r) => r.id));
      return `Found ${rows.length} vault entr${rows.length === 1 ? 'y' : 'ies'} containing "${query}" (exact match):\n\n${lines.join('\n\n')}${bridgeSection}\n\nUse vault_get(entry_id="…") for full content, vault_update to correct, vault_forget to mark obsolete.`;
    }

    // personalOnly matches exact mode (namespace IS NULL): squad entries flow via squad_recall.
    // Author scope is resolveRecallScope, a separate axis from namespaces.
    const results = await semanticSearch(query, { limit, type, agentId, personalOnly: true });
    // Tell the agent when the recency cap cut the search short (as `memory/retrieval.ts` does for messages):
    // otherwise "I have no record of that" cannot be told from "I did not read that far".
    const window = lastSemanticSearchWindow();
    const windowNotice = window.truncated
      ? `\n\n[searched the newest ${window.cap.toLocaleString('en-US')} vault entries only, `
        + ` nothing older than entry #${window.oldestRidConsidered} was scored. Retry with`
        + ` mode: "exact" for a literal string, or narrow the query.]`
      : '';
    const bridge = searchUnfiledArchives(agentId, query, { mode: 'token' });

    if (results.length === 0) {
      if (bridge.length > 0) {
        return `No distilled vault entries matched yet, but the just-archived previous session does:\n\n${formatUnfiledBridgeForSearch(bridge)}${windowNotice}`;
      }
      return 'No matching memories found in the vault. If you are looking for a specific literal string (e.g. an exact name or typo), retry with mode: "exact".'
        + windowNotice;
    }

    // Per-entry snippet cap keeps results bounded; full content is available through vault_get.
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
      return `${i + 1}. [${r.type}]${flagStr}${conf} ${snippet}${formatCitationSuffix(r.citation)}\n   ID: ${r.id} | Similarity: ${r.similarity.toFixed(2)} | Created: ${r.createdAt}`;
    });

    const truncatedCount = results.filter((r) => r.content.length > SNIPPET_CHARS).length;
    const expandHint =
      truncatedCount > 0
        ? `\n\n${truncatedCount} entry${truncatedCount === 1 ? '' : 'ies'} truncated. Use vault_get(entry_id="…") for the full content.`
        : '';

    const bridgeSection = bridge.length > 0 ? `\n\n${formatUnfiledBridgeForSearch(bridge)}` : '';
    recordVaultUse(results.map((r) => r.id));

    return `Found ${results.length} vault memor${results.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n\n')}${expandHint}${bridgeSection}${windowNotice}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('vault_search failed', { error: msg }, agentId);
    return `Error searching vault: ${msg}`;
  }
}

// By-id access guard for vault_update / vault_forget: a leaked entry id must not grant an edit of another
// agent's private entry. The author, squad-shared and owner-authored entries pass, and the main agent may
// correct or forget any household entry. Reads as "not found" so it does not leak existence.
function ownedByOtherAgent(entry: { agentId: string; namespace: string | null }, callerAgentId: string): boolean {
  if (entry.agentId === callerAgentId || entry.namespace !== null || entry.agentId === OWNER_VAULT_AGENT_ID) return false;
  return !(isPrimaryAgent(callerAgentId) && resolveRecallScope(callerAgentId).includes(entry.agentId));
}

// READ gate for vault_get: a member may open a hit authored by another household member (recall surfaced it);
// a non-member gets "not found". The author must be in the caller's resolveRecallScope; squad-namespaced and
// owner-authored entries stay readable.
function ownedByNonHouseholdAgent(entry: { agentId: string; namespace: string | null }, callerAgentId: string): boolean {
  if (entry.namespace !== null) return false;                 // squad-shared: readable
  if (entry.agentId === OWNER_VAULT_AGENT_ID) return false;   // owner-authored: readable
  if (entry.agentId === callerAgentId) return false;          // own entry
  return !resolveRecallScope(callerAgentId).includes(entry.agentId);
}

// ── vault_update ──
// Atomic content replacement that keeps the entry ID, with a required reason for auditability.
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
  if (!existing || ownedByOtherAgent(existing, agentId)) return `Error: Vault entry "${entryId}" not found.`;
  if (existing.isObsolete) {
    return `Error: Entry "${entryId}" is already marked obsolete. Use vault_remember to create a fresh entry instead.`;
  }

  // The same compression contract as vault_remember; the owner's entries, pinned entries and standing
  // instructions keep their length. A leading date stamp is not counted, as on vault_remember.
  if (agentId !== OWNER_VAULT_AGENT_ID && !existing.isPinned && !isStandingInstruction(newContent)) {
    const refusal = compressionRefusal(existing.type, newContent.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, ''), 'vault_update');
    if (refusal) return refusal;
  }

  const cutNote = isOverEntryLimit(newContent) ? `\n${AGENT_ENTRY_CUT_NOTE}` : '';
  const updated = updateEntry(entryId, { content: newContent });
  if (!updated) return `Error: Failed to update vault entry "${entryId}".`;

  logger.info('Vault entry updated', { id: entryId, reason, agentId });
  return `Updated [${updated.type}] entry ${entryId}.\nReason: ${reason}\nNew content (first 200 chars): "${updated.content.slice(0, 200)}${updated.content.length > 200 ? '…' : ''}"${cutNote}`;
}

// vault_get: full content of one entry, pairing with vault_search's compact snippets.
export function executeVaultExpand(
  agentId: string,
  args: Record<string, unknown>,
): string {
  const entryId = args.entry_id as string | undefined;
  if (!entryId) return 'Error: entry_id is required.';
  const entry = getEntry(entryId);
  if (!entry || ownedByNonHouseholdAgent(entry, agentId)) return `Error: Vault entry "${entryId}" not found.`;

  const flags: string[] = [];
  if (entry.isPinned) flags.push('pinned');
  if (entry.isPermanent) flags.push('permanent');
  if (entry.isObsolete) flags.push('obsolete');
  const flagStr = flags.length > 0 ? ` {${flags.join(',')}}` : '';

  // Shows the FULL source (search and recall shorten file paths to a basename) so it can be re-opened.
  let sourceLine = '';
  if (entry.citation) {
    try {
      const c = JSON.parse(entry.citation) as { ref?: string; page?: number; section?: string };
      if (c && typeof c.ref === 'string' && c.ref.length > 0) {
        let s = c.ref;
        if (typeof c.page === 'number' && Number.isFinite(c.page)) s += ` p.${c.page}`;
        if (typeof c.section === 'string' && c.section.trim().length > 0) s += ` (${c.section.trim()})`;
        sourceLine = `Source: ${s}\n`;
      }
    } catch { /* malformed citation, skip the line */ }
  }

  return (
    `[${entry.type}]${flagStr}\n` +
    `ID: ${entry.id}\n` +
    `Created: ${entry.createdAt}\n` +
    (entry.tags && entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}\n` : '') +
    sourceLine +
    `\n${entry.content}`
  );
}


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
  if (!entry || ownedByOtherAgent(entry, agentId)) return `Error: Vault entry "${entryId}" not found.`;
  if (entry.isObsolete) return `Entry "${entryId}" is already marked as obsolete.`;

  markObsolete(entryId, reason);
  return `Marked as obsolete: [${entry.type}] "${entry.content.slice(0, 80)}..."\nReason: ${reason}`;
}
