// ════════════════════════════════════════
// Vault Tools: vault_remember, vault_search, vault_forget
// Agent-callable tools for interacting with the vault
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { createEntry, semanticSearch, findNearDuplicateEntry, markObsolete, getEntry, updateEntry, listEntries, formatCitationSuffix, resolveRecallScope, OWNER_VAULT_AGENT_ID } from './store.js';
import { searchUnfiledArchives, UNFILED_ARCHIVE_LABEL, type UnfiledArchiveSnippet } from './retrieval.js';

const logger = createLogger('vault-tools');

// ── vault_remember ──
//
// Goals (per user direction): every entry should be a SUMMARY of source
// content (not a transcription) and should have a REASON to exist. We
// don't reject entries by length, prose shape, or technique overlap, 
// the prompt sets the bar, the engine just helps quietly:
//   - Strip common narrative cruft so transcribed-feeling entries lose
//     their filler before saving.
//   - Surface near-duplicate alerts so the agent sees when it's drifting.
//   - Surface technique-overlap as info (not a block).

// Common bloat-phrase patterns the engine strips silently. These are
// narrative fillers the model writes that carry no information ("the
// user mentioned that…", "during a conversation on…"). Conservative by
// design, only patterns that are unambiguous filler.
const BLOAT_STRIP_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Date prefix, we already auto-prepend [YYYY-MM-DD], so a duplicate
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

// Credential-shaped content must not enter the vault. Credentials live in
// the separate encrypted store (agent_credentials table, accessed via
// credential_add/get/update/delete). Vault entries can decay, appear in
// vault_search, and are visible to the Dreamer for summarization, none
// of which is appropriate for API keys, tokens, or passwords.
//
// Detection is high-precision (known token prefixes + key/value with
// credential-named keys and substantive values). A false positive here is
// cheap (the agent re-routes to credential_add); a false negative would
// silently leak a secret into the vault.
const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'GitHub PAT', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub OAuth token', re: /\bgh[osu]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Shopify access token', re: /\bshp(?:pa|at|ca|ss)_[A-Za-z0-9]{16,}\b/ },
  { name: 'Stripe key', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'OpenAI key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: 'Slack token', re: /\bxox[bpars]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35,}\b/ },
  { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  // Credential-shaped key/value pairs. Requires an explicit credential-named
  // key, an assignment operator (: or =), and a non-trivial value (>=8 chars).
  // Conservative enough to allow notes like "the user has a github account"
  // while catching "api_key: shppa_FAKE_a1b2c3d4e5f6".
  {
    name: 'credential-shaped key/value',
    re: /\b(?:api[_-]?key|api[_-]?secret|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|access[_-]?token|session[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*['"]?[A-Za-z0-9_+/=.~!@#$%^&*-]{8,}/i,
  },
];

function detectCredentialContent(content: string): string | null {
  for (const { name, re } of CREDENTIAL_PATTERNS) {
    if (re.test(content)) return name;
  }
  return null;
}

// ── FA-V5 (D-C): vault entry compression enforcement ──
//
// The DREAMER-SOUL documents hard per-type length caps and a prose-shape bounce.
// This is the ONE shared source of truth for those caps (the SOUL wording is
// kept in sync). Enforced only on the vault_remember TOOL path
// (executeVaultRemember) so the model gets a corrective "compress and retry"
// error; direct engine writers (the dashboard vault API's createEntry) are not
// gated. The cap is measured on CONTENT only, so future citation metadata rides
// free (FU-2), and the engine date prefix is added AFTER this gate.
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

// Exemption (b): the SOUL's EXCEPTION class. User-explicit standing instructions
// ("remember that ...", "always ...", "never ...", "from now on ...") are saved
// as-is, never bounced for length or shape. Matched conservatively on the SOUL's
// own trigger phrases; worst case a borderline entry that mentions "always"
// saves uncompressed, which is the safe direction for a user directive.
const STANDING_INSTRUCTION_RE =
  /\b(?:remember (?:that|to|this)|i want you to remember|make sure you (?:remember|always|never)|always|never|from now on|going forward|from this point on|do not ever)\b/i;

function isStandingInstruction(content: string): boolean {
  return STANDING_INSTRUCTION_RE.test(content);
}

// Sentence terminators: a '.', '!' or '?' followed by whitespace or end of
// string. Telegraphic entries ("Tunnel: X. Why: Y.") have few; a multi-sentence
// narrative has many.
function countSentenceTerminators(content: string): number {
  return (content.match(/[.!?](?:\s|$)/g) ?? []).length;
}

// Prose-shape bounce (conservative, length-dominant per the finding's caution
// that shape detection is floor-fragile). Bounce ONLY when BOTH hold: the entry
// is over half its type cap AND it has 3+ sentence terminators. Short entries
// and 1-2 sentence telegraphic lines are never bounced. Deliberately does NOT
// use a subject-verb-start heuristic (too eager to false-positive telegraphic
// lines that begin with a pronoun).
function isProseShaped(content: string, cap: number, terminators: number): boolean {
  if (content.length <= cap / 2) return false;
  return terminators >= 3;
}

// ── FU-2: source citation ──
// Build the compact citation JSON from the tool's flat citation params. Flat
// scalars (source_ref + optional source_page/source_section) are used instead of
// a nested object because the floor model (DeepSeek V4 Flash) fills flat string
// params far more reliably than it fills a nested {kind, ref, page} object. The
// engine derives `kind` here (deterministic), so the model never has to. Returns
// null when no source_ref was given, so citation stays optional everywhere. This
// is METADATA: it never touches `content`, so it rides free past the FA-V5 caps.
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
  const permanent = (args.permanent as boolean) ?? false;
  const verbatim = (args.verbatim as boolean) ?? false;
  // RC-7: the model sets this true after a near-duplicate bounce to assert the
  // new fact is genuinely different from the entry it resembles (not a
  // correction of it), overriding the pre-save near-duplicate bounce below.
  const distinct = (args.distinct as boolean) ?? false;

  if (!content) return 'Error: content is required.';
  if (!type) return 'Error: type is required (fact, preference, decision, procedure, relationship, event, or note).';

  const validTypes = ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'];
  if (!validTypes.includes(type)) {
    return `Error: type must be one of: ${validTypes.join(', ')}`;
  }

  // Refuse to stash technique content. Techniques are mutable on disk
  // and the engine deliberately stubs prior technique reads after 1
  // turn so agents always re-fetch the current version. Letting the
  // agent vault_remember a chunk of technique text would re-introduce
  // the staleness this enforcement was built to prevent. Detection is
  // by sentinel, every technique_read / use_technique response carries
  // it (techniques/tools.ts:wrapTechniqueResult). If the agent wants
  // to capture WHY they made a decision while following a technique,
  // they can vault the decision itself ("chose path A because the
  // technique said X") rather than copy-pasting the technique body.
  if (content.includes('══ TECHNIQUE FRESH READ ══')) {
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

  // ── Verbatim mode ──
  // When the user explicitly says "remember that X", "always Y", "never Z",
  // etc., the agent passes verbatim: true so the engine preserves the
  // instruction exactly: no bloat-strip, no date prefix, no compression.
  // The point of the entry is to capture the user's words faithfully.
  let charsRemoved = 0;
  if (!verbatim) {
    // Strip common narrative cruft silently (the SOUL notes the engine strips
    // bloat before measuring length, so this runs before the cap gate below).
    const result = stripBloatPhrases(content);
    content = result.stripped;
    charsRemoved = result.charsRemoved;
  }

  // ── FA-V5 (D-C): enforce the compression contract on the tool path ──
  // The SOUL documents hard per-type length caps and a prose-shape bounce;
  // nothing used to enforce them (createEntry just truncated at 500 tokens, so
  // over-length prose saved silently). Enforce here so the model gets a
  // corrective error and retries. Three exemptions bypass BOTH checks:
  //   (a) verbatim:true         - the user's exact words, never bounced
  //   (b) standing-instruction  - the SOUL's "remember that / always / never"
  //                               EXCEPTION class, detected on the content
  //   (c) owner-authored        - agent_id === OWNER_VAULT_AGENT_ID
  // Measured on CONTENT only (the engine date prefix is added AFTER this gate,
  // and future citation metadata rides free - FU-2).
  const exemptFromCompression =
    verbatim || agentId === OWNER_VAULT_AGENT_ID || isStandingInstruction(content);
  if (!exemptFromCompression) {
    const cap = VAULT_ENTRY_CHAR_CAPS[type] ?? DEFAULT_ENTRY_CHAR_CAP;
    if (content.length > cap) {
      return (
        `Too long for a [${type}] vault entry: ${content.length} chars, cap is ${cap}. ` +
        `Vault entries are compressed shorthand, not prose. Rewrite it shorter: lead with the noun, ` +
        `cut filler words, keep only the durable fact (example shape: "Tunnel: Cloudflare named. Reason: self-hosted integration."), ` +
        `then call vault_remember again. (If the user told you to remember something word-for-word, pass verbatim: true to save it exactly.) ` +
        `Do not report this as saved or stored; nothing was written.`
      );
    }
    const terminators = countSentenceTerminators(content);
    if (isProseShaped(content, cap, terminators)) {
      return (
        `Reads like narrative prose for a [${type}] vault entry (${terminators} sentences). ` +
        `Vault entries are one telegraphic line, not a story. Rewrite it as a single compressed line: lead with the noun, ` +
        `drop the "the user/we/I did X" framing, keep only the durable fact under ${cap} chars, ` +
        `then call vault_remember again. (If the user told you to remember something word-for-word, pass verbatim: true to save it exactly.) ` +
        `Do not report this as saved or stored; nothing was written.`
      );
    }
  }

  // Auto-prepend today's date if the content doesn't already start with a date
  // stamp. Keeps every entry temporally anchored. Non-verbatim only, and after
  // the cap gate so the engine-added stamp never counts against the user.
  if (!verbatim && !/^\[?\d{4}-\d{2}/.test(content)) {
    const dateStr = new Date().toISOString().split('T')[0];
    content = `[${dateStr}] ${content}`;
  }

  // FU-2: capture the source citation (URL / file / doc + optional page/section)
  // if the caller provided one. Built from CONTENT-free params, so it never
  // affected the cap gate above.
  const citation = buildCitationJson(args);

  // ── RC-7: pre-save near-duplicate bounce (the FA-V5 corrective pattern) ──
  // The 0.78-0.92 band was previously checked AFTER saving and produced only an
  // FYI the floor model ignored, so near-duplicates accumulated. Check it BEFORE
  // createEntry and refuse the save: name the existing entry and steer the model
  // to vault_update it (the right primitive) or re-affirm with distinct:true for
  // a genuinely different fact. Same exemptions as the compression gate (verbatim
  // / owner-authored / standing-instruction), plus distinct:true. The >=0.92
  // auto-supersede inside createEntry is unchanged, and non-tool writers
  // (Dreamer/extraction) call createEntry directly, so they never bounce here.
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
      citation,
    });

    const flags: string[] = [];
    if (pin) flags.push('pinned');
    if (permanent) flags.push('permanent');
    const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';

    // RC-7: the 0.78-0.92 near-duplicate band is now a PRE-save bounce above
    // (findNearDuplicateEntry), so a successful save is known not to collide with
    // an existing entry in that band. No post-save FYI is emitted.

    const compressionNote = charsRemoved > 0
      ? `\n(Engine stripped ${charsRemoved} chars of narrative filler before saving.)`
      : '';

    // FU-2: echo the captured source so the agent can confirm it stuck.
    const citationSuffix = formatCitationSuffix(entry.citation);

    return `Remembered [${type}]${flagStr}: "${entry.content.slice(0, 120)}${entry.content.length > 120 ? '…' : ''}"${citationSuffix}\nEntry ID: ${entry.id}${compressionNote}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('vault_remember failed', { error: msg }, agentId);
    return `Error saving to vault: ${msg}`;
  }
}

// ── vault_search ──

// FN-1 bridge: format snippets from the just-archived-but-unfiled session for a
// vault_search result. Same label as the context-injection path so the agent
// always sees this content described the same way. These come from raw recent
// conversation the Dreamer has not yet distilled into vault_entries, so no
// entry IDs are shown (there is nothing to vault_get / vault_update yet).
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
  // Phase 3.5 (2026-05-04), default limit lowered from 10 to 5 to keep
  // search results compact. The agent can still pass a higher limit when
  // they genuinely want more matches.
  const limit = (args.limit as number) ?? 5;
  // v2.7.2, explicit mode. 'semantic' (default) uses embedding similarity
  // which is great for conceptual recall but blind to exact strings, 
  // searching for an unusual literal substring like a misspelled domain
  // against the user's actual domain returns nothing relevant because
  // both embed to the same generic "email domain" cluster. 'exact' uses
  // SQL LIKE on the content field, use it for debugging memory poisoning
  // or finding entries that contain a specific phrase verbatim.
  const mode = (args.mode as 'semantic' | 'exact' | undefined) ?? 'semantic';

  if (!query) return 'Error: query is required.';

  try {
    const SNIPPET_CHARS = 200;

    if (mode === 'exact') {
      // W3-4: scoped to the calling agent's own vault plus the owner scope
      // (per-agent by design; squad namespaces + owner-authored dashboard
      // entries are the deliberate sharing mechanisms).
      const rows = listEntries({ search: query, type, limit, agentId, includeOwnerScope: true });
      // FN-1: exact mode uses substring matching against still-unfiled archives.
      const bridge = searchUnfiledArchives(agentId, query, { mode: 'substring' });
      if (rows.length === 0) {
        // Nothing distilled yet, but the fact may sit in a just-archived
        // session the Dreamer has not processed. Surface it (labeled) rather
        // than reporting a bare miss.
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
        // Show a snippet anchored on the match so the agent can see context.
        const idx = r.content.toLowerCase().indexOf(query.toLowerCase());
        const start = idx === -1 ? 0 : Math.max(0, idx - 60);
        const end = idx === -1 ? SNIPPET_CHARS : Math.min(r.content.length, idx + query.length + 140);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < r.content.length ? '…' : '';
        const snippet = prefix + r.content.slice(start, end) + suffix;
        return `${i + 1}. [${r.type}]${flagStr} ${snippet}${formatCitationSuffix(r.citation)}\n   ID: ${r.id} | Created: ${r.createdAt}`;
      });
      const bridgeSection = bridge.length > 0 ? `\n\n${formatUnfiledBridgeForSearch(bridge)}` : '';
      return `Found ${rows.length} vault entr${rows.length === 1 ? 'y' : 'ies'} containing "${query}" (exact match):\n\n${lines.join('\n\n')}${bridgeSection}\n\nUse vault_get(entry_id="…") for full content, vault_update to correct, vault_forget to mark obsolete.`;
    }

    // W3-4/D-A: recall author scope is resolveRecallScope(agentId) (vault/store.js),
    // household-shared for members, self+owner otherwise.
    // FA-V6: personalOnly:true so semantic mode matches exact mode's contract
    // (listEntries above defaults to namespace IS NULL). Squad-namespaced entries
    // stay OUT of personal recall and flow via squad_recall instead. This remains
    // correct under D-A: household sharing is BUILT and LIVE, but it is a separate
    // AXIS (which author ids are in scope), not namespaces; squad namespaces stay opt-in.
    const results = await semanticSearch(query, { limit, type, agentId, personalOnly: true });
    // FN-1: semantic mode uses token-overlap matching against unfiled archives.
    const bridge = searchUnfiledArchives(agentId, query, { mode: 'token' });

    if (results.length === 0) {
      if (bridge.length > 0) {
        return `No distilled vault entries matched yet, but the just-archived previous session does:\n\n${formatUnfiledBridgeForSearch(bridge)}`;
      }
      return 'No matching memories found in the vault. If you are looking for a specific literal string (e.g. an exact name or typo), retry with mode: "exact".';
    }

    // Phase 3.5, per-entry snippet cap at 200 chars. Full content is
    // available on demand via vault_get(entry_id). Keeps search results
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
      return `${i + 1}. [${r.type}]${flagStr}${conf} ${snippet}${formatCitationSuffix(r.citation)}\n   ID: ${r.id} | Similarity: ${r.similarity.toFixed(2)} | Created: ${r.createdAt}`;
    });

    const truncatedCount = results.filter((r) => r.content.length > SNIPPET_CHARS).length;
    const expandHint =
      truncatedCount > 0
        ? `\n\n${truncatedCount} entry${truncatedCount === 1 ? '' : 'ies'} truncated. Use vault_get(entry_id="…") for the full content.`
        : '';

    // FN-1: append the unfiled-archive bridge after the distilled entries.
    const bridgeSection = bridge.length > 0 ? `\n\n${formatUnfiledBridgeForSearch(bridge)}` : '';

    return `Found ${results.length} vault memor${results.length === 1 ? 'y' : 'ies'}:\n\n${lines.join('\n\n')}${expandHint}${bridgeSection}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('vault_search failed', { error: msg }, agentId);
    return `Error searching vault: ${msg}`;
  }
}

// W3-4: by-id access guard. The personal vault is per-agent; an entry id
// leaked across agents (pre-fix search was unscoped) must not grant read,
// update, or forget access to another agent's private entry. Namespaced
// (squad-shared) and owner-authored (dashboard, OWNER_VAULT_AGENT_ID)
// entries remain accessible, that sharing is deliberate.
// Reads as "not found" so the guard does not leak the entry's existence.
//
// AUTHOR-restricted gate: kept for vault_update / vault_forget (a destructive
// edit across two different humans' agents must go through the owner via the
// dashboard, not one member mutating another member's memory).
function ownedByOtherAgent(entry: { agentId: string; namespace: string | null }, callerAgentId: string): boolean {
  return entry.agentId !== callerAgentId && entry.namespace === null && entry.agentId !== OWNER_VAULT_AGENT_ID;
}

// D-A: READ gate for vault_get / executeVaultExpand. Relaxed from author-only to
// household: a member can open a search hit authored by ANOTHER member (household
// recall surfaces the snippet, so the agent must be able to expand it). A
// non-member (probe, spawned worker, legacy service agent) still gets "not found"
// for a member's entry. Squad-namespaced and owner-authored entries stay readable
// (that sharing is deliberate). resolveRecallScope encodes the member-vs-nonmember
// logic once: for a member caller it returns the full household set; for a
// non-member it returns [self, OWNER]. So "not household" == the author is not in
// the caller's recall scope, exactly the set the caller may have surfaced.
function ownedByNonHouseholdAgent(entry: { agentId: string; namespace: string | null }, callerAgentId: string): boolean {
  if (entry.namespace !== null) return false;                 // squad-shared: readable
  if (entry.agentId === OWNER_VAULT_AGENT_ID) return false;   // owner-authored: readable
  if (entry.agentId === callerAgentId) return false;          // own entry
  return !resolveRecallScope(callerAgentId).includes(entry.agentId);
}

// ── vault_update ──
// v2.7.2, atomic content replacement for an existing vault entry. Pre-
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
  if (!existing || ownedByOtherAgent(existing, agentId)) return `Error: Vault entry "${entryId}" not found.`;
  if (existing.isObsolete) {
    return `Error: Entry "${entryId}" is already marked obsolete. Use vault_remember to create a fresh entry instead.`;
  }

  const updated = updateEntry(entryId, { content: newContent });
  if (!updated) return `Error: Failed to update vault entry "${entryId}".`;

  logger.info('Vault entry updated', { id: entryId, reason, agentId });
  return `Updated [${updated.type}] entry ${entryId}.\nReason: ${reason}\nNew content (first 200 chars): "${updated.content.slice(0, 200)}${updated.content.length > 200 ? '…' : ''}"`;
}

// Phase 3.5 (2026-05-04), vault_get: return the full content of one
// specific vault entry. Pairs with vault_search's compact-by-default
// snippets, agents skim search results, then expand the few that matter.
export function executeVaultExpand(
  agentId: string,
  args: Record<string, unknown>,
): string {
  const entryId = args.entry_id as string | undefined;
  if (!entryId) return 'Error: entry_id is required.';
  const entry = getEntry(entryId);
  // D-A: household-relaxed read gate (a member may expand another member's hit).
  if (!entry || ownedByNonHouseholdAgent(entry, agentId)) return `Error: Vault entry "${entryId}" not found.`;

  const flags: string[] = [];
  if (entry.isPinned) flags.push('pinned');
  if (entry.isPermanent) flags.push('permanent');
  if (entry.isObsolete) flags.push('obsolete');
  const flagStr = flags.length > 0 ? ` {${flags.join(',')}}` : '';

  // FU-2: show the FULL source here (unlike search/recall, which shorten file
  // paths to a basename) so the agent can re-open the original from vault_get.
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
  if (!entry || ownedByOtherAgent(entry, agentId)) return `Error: Vault entry "${entryId}" not found.`;
  if (entry.isObsolete) return `Entry "${entryId}" is already marked as obsolete.`;

  markObsolete(entryId, reason);
  return `Marked as obsolete: [${entry.type}] "${entry.content.slice(0, 80)}..."\nReason: ${reason}`;
}
