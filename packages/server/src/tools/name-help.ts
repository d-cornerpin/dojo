// ════════════════════════════════════════════════════════════════════════════
// NAME-HELP (T80a — "a wrong tool name is not a permission problem")
//
// THE INCIDENT: an agent guessed five tool names that do not exist
// (`user_gmail_label_add`, `user_gmail_update`, `user_gmail_modify`,
// `gmail_label_add`, `gmail_add_label`) while trying to label an email. The
// engine answered every one of them with a PERMISSION verdict — "this is a
// permission issue, not a format issue" — plus an instruction to tell the
// user it was blocked. The agent had full access the whole time; it just
// never called the one real tool, `user_gmail_label`. It reported itself
// blocked because the engine told it, confidently, that it was.
//
// THIS MODULE exists so every tool-name failure text tells the TRUTH: a name
// nobody has ever heard of is a NAMING problem (fix the spelling, try again),
// and a name that is real but withheld from THIS agent is a PERMISSION
// problem (escalate). Those are different facts and the model needs to know
// which one it is looking at, because the recovery instructions are opposite:
// "call load_tool_docs with the right name" vs. "ask the user / escalate".
//
// ── A PURE LEAF, DELIBERATELY ──
// This module imports nothing from the tool registry, the surface, or any
// handler. Every function takes `allowed` (this agent's advertised tool
// names) and `known` (the platform's full tool universe) as plain `Set`
// arguments. That keeps this file cycle-free and trivially testable — no
// database, no agent id, no I/O — and it means every call site is
// responsible for sourcing those two sets correctly rather than this module
// reaching backward for them.
//
// WHERE CALLERS GET `known` FROM: the global tool universe is
// `agent/tools/definitions.ts`'s `getAllToolDefinitions()` — the declared
// union of family arrays (`toolDefinitions` + pdf + Google
// read/write/slides/forms + Microsoft read/write/office + plaud +
// credentials + unified) that `agent/tools/surface.ts`'s `getFilteredTools`
// filters FROM. `agent/tools/registry.ts`'s `registryToolDefinitions()`
// wraps this SAME array (deduplicated, memoized) for `tools/index-generator.ts`
// to walk when writing the on-disk tool-docs index — same authority, same
// name set either way; call sites here use `getAllToolDefinitions()` directly
// because `registry.ts` pulls in the full handler table (`handlers.ts`,
// which imports every `cat/*.ts` including this module's own callers) and a
// leaf-facing call site should not manufacture an import cycle to reach a
// list `definitions.ts` already hands out cycle-free.
//
// WHERE CALLERS GET `allowed` FROM: `getFilteredTools(agentId)` — this
// agent's advertised surface. R3 (below) requires suggestions come only from
// here, never from `known`.
//
// ── R5 (OWNER RULING) — GENERIC ACROSS EVERY TOOL, NO FAMILY BRANCHES ──
// The incident's five names are TEST FIXTURES, not special cases. Nothing
// below reads "gmail", "google" or "microsoft" as a string to special-case.
// The one piece of domain knowledge this module carries is a small,
// provider-agnostic table of common CRUD-ish verb near-synonyms (create/add,
// update/modify/label, delete/remove, read/get, list, search) used to score
// suggestions — the same table would fire identically for a hypothetical
// `calendar_` or `file_` tool family. See `VERB_SYNONYM_BUCKETS`.
// ════════════════════════════════════════════════════════════════════════════

/** What a requested tool name actually is, relative to one agent. */
export type ToolNameVerdict = 'allowed' | 'exists_not_allowed' | 'unknown';

/**
 * The one classification every call site needs: is this name something the
 * agent may call right now, something that exists for SOME agent but not
 * this one, or something that was never a real tool at all?
 *
 * `known` must be the global tool universe (see module header); a name
 * present in `allowed` is by construction also present in `known` at any
 * consistent call site, but `allowed` is checked first regardless so a
 * caller that passes a stale/partial `known` set still gets the right
 * answer for names the agent can actually use.
 */
export function classifyToolName(requested: string, allowed: Set<string>, known: Set<string>): ToolNameVerdict {
  if (allowed.has(requested)) return 'allowed';
  if (known.has(requested)) return 'exists_not_allowed';
  return 'unknown';
}

// ── Scoring machinery for suggestToolNames ──────────────────────────────────

function normalizeName(name: string): string {
  const lower = name.toLowerCase();
  return lower.startsWith('user_') ? lower.slice('user_'.length) : lower;
}

function rawTokens(name: string): string[] {
  return normalizeName(name).split('_').filter(Boolean);
}

/**
 * PROVIDER-AGNOSTIC verb near-synonyms. Tool names across every family in
 * this codebase follow a rough `<domain>_<verb>[_<object>]` shape, and a
 * guessed name very often gets the domain right and picks a near-synonym
 * verb ("update"/"modify" for what the real tool calls "label" — i.e. "tag
 * this message", a mutation). Bucketing these lets shared-token scoring see
 * past the exact-spelling mismatch without knowing anything about Gmail,
 * Google, or Microsoft specifically: the same table fires for a guessed
 * `calendar_modify` against a real `calendar_reschedule`.
 *
 * "add"/"attach"/"apply" sit with the MUTATE bucket (attaching or changing a
 * property of something that already exists), deliberately separate from
 * CREATE (bringing a brand-new resource into existence) — "add a label to
 * this message" and "create a new label" are different operations, and
 * collapsing them made a guessed `gmail_add_label` score a perfect match
 * against `gmail_create_label` instead of the real `gmail_label`.
 */
const VERB_SYNONYM_BUCKETS: readonly (readonly string[])[] = [
  ['create', 'new', 'insert', 'make'],
  ['delete', 'remove', 'del', 'drop', 'destroy', 'clear'],
  ['update', 'modify', 'edit', 'change', 'set', 'label', 'tag', 'mark', 'rename', 'add', 'attach', 'apply'],
  ['read', 'get', 'fetch', 'view', 'show', 'inspect'],
  ['list', 'enumerate', 'ls'],
  ['search', 'find', 'query', 'lookup'],
];

const CANONICAL_VERB = new Map<string, string>();
for (const bucket of VERB_SYNONYM_BUCKETS) {
  const canonical = bucket[0];
  for (const word of bucket) CANONICAL_VERB.set(word, canonical);
}

function canonicalTokens(name: string): string[] {
  return rawTokens(name).map((t) => CANONICAL_VERB.get(t) ?? t);
}

/** Standard Levenshtein edit distance. Tool names are short; no need for a
 * fancier algorithm. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

interface ScoredCandidate {
  name: string;
  containment: number; // 1 if one normalized form contains the other, else 0
  sharedTokens: number; // count of shared canonical tokens
  distance: number; // edit distance between normalized forms
}

function scoreCandidate(requestedNorm: string, requestedCanonTokens: Set<string>, candidate: string): ScoredCandidate {
  const candidateNorm = normalizeName(candidate);
  const containment = (candidateNorm.includes(requestedNorm) || requestedNorm.includes(candidateNorm)) ? 1 : 0;
  const candidateCanonTokens = canonicalTokens(candidate);
  const sharedTokens = new Set(candidateCanonTokens.filter((t) => requestedCanonTokens.has(t))).size;
  const distance = editDistance(requestedNorm, candidateNorm);
  return { name: candidate, containment, sharedTokens, distance };
}

function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.containment !== b.containment) return b.containment - a.containment;
  if (a.sharedTokens !== b.sharedTokens) return b.sharedTokens - a.sharedTokens;
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.name.length !== b.name.length) return a.name.length - b.name.length; // (d) shorter name wins ties
  return a.name.localeCompare(b.name); // final deterministic tiebreak
}

/**
 * Suggest up to `limit` real tool names close to `requested`, drawn ONLY
 * from `allowed` (R3/R4 — never from `known`; a tool that exists globally
 * but this agent cannot use must never be pointed at as the fix for a
 * naming mistake, that would just trade a naming error for a confusing
 * permission error).
 *
 * Ranked by (a) substring/superstring containment of the normalized form,
 * then (b) shared canonical-token count, then (c) edit distance, then
 * (d) shorter name. If the top-ranked candidate has neither containment nor
 * any shared token, the match is too weak to be useful — returns `[]` rather
 * than invent a confident-looking wrong pointer.
 */
export function suggestToolNames(requested: string, allowed: Set<string>, limit = 3): string[] {
  const requestedNorm = normalizeName(requested);
  const requestedCanonTokens = new Set(canonicalTokens(requested));

  const scored: ScoredCandidate[] = [];
  for (const candidate of allowed) {
    if (candidate === requested) continue;
    scored.push(scoreCandidate(requestedNorm, requestedCanonTokens, candidate));
  }
  if (scored.length === 0) return [];

  scored.sort(compareScored);

  const top = scored[0];
  if (top.containment === 0 && top.sharedTokens === 0) return [];

  return scored
    .filter((c) => c.containment > 0 || c.sharedTokens > 0)
    .slice(0, limit)
    .map((c) => c.name);
}

/**
 * The shared sentence(s) every tool-name-failure call site emits. Classifies
 * every name in `requested`, then reports the UNKNOWN group and the
 * EXISTS-BUT-NOT-ALLOWED group SEPARATELY (R5 mixed-case decision — a call
 * that guessed two names and also asked for one real-but-denied tool must
 * not have either group's wording swallow the other's).
 *
 * The UNKNOWN group never carries permission/escalation language: the next
 * action is to call `load_tool_docs` with a correct name, never "tell the
 * user you are blocked" (that instruction is what produced the incident).
 * The EXISTS-BUT-NOT-ALLOWED group keeps the existing permission framing and
 * escalation advice (complete_task when this agent can self-complete,
 * otherwise send_to_agent / tell the user), unchanged from before this task.
 *
 * Names that classify as `allowed` are not failures and are silently
 * skipped — a caller should not be passing them in, but this stays honest
 * rather than misreporting one if it slips through.
 */
export function describeNameFailure(requested: string[], allowed: Set<string>, known: Set<string>): string {
  const unknownNames: string[] = [];
  const notAllowedNames: string[] = [];
  for (const name of requested) {
    const verdict = classifyToolName(name, allowed, known);
    if (verdict === 'unknown') unknownNames.push(name);
    else if (verdict === 'exists_not_allowed') notAllowedNames.push(name);
  }

  const sentences: string[] = [];

  if (unknownNames.length > 0) {
    const plural = unknownNames.length > 1;
    const described = unknownNames.map((name) => {
      const suggestions = suggestToolNames(name, allowed);
      return suggestions.length > 0
        ? `"${name}" (did you mean ${suggestions.join(', ')}?)`
        : `"${name}" (no close match found)`;
    });
    sentences.push(
      `${plural ? 'These tool names do not exist' : 'This tool name does not exist'}: ${described.join('; ')}. ` +
      'This is a naming problem, not a permission problem: the tool was never denied, it was never real. ' +
      'Call load_tool_docs with the correct name.',
    );
  }

  if (notAllowedNames.length > 0) {
    const plural = notAllowedNames.length > 1;
    const canSelfComplete = allowed.has('complete_task');
    const escalation = canSelfComplete
      ? 'Ask the user to update this agent\'s permissions, or call complete_task(status="blocked").'
      : 'Ask the user to update this agent\'s permissions, use send_to_agent to reach an agent with broader permissions, or tell the user you are blocked.';
    sentences.push(
      `${plural ? 'These tools exist but are not accessible to this agent' : 'This tool exists but is not accessible to this agent'}: ${notAllowedNames.join(', ')}. ` +
      'This is a permission issue, not a format issue: the tool(s) may exist for other agents but are not on this agent\'s allow list, or a permission filter is stripping them ' +
      '(e.g. web_search/web_fetch require network_domains != "none", exec requires exec_allow non-empty, file_read requires file_read permission). ' +
      escalation,
    );
  }

  return sentences.join(' ');
}
