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
// WHERE CALLERS GET `known` FROM: `agent/tools/definitions.ts`'s
// `getAllToolDefinitions()` — the declared union of family arrays
// (`toolDefinitions` + pdf + Google read/write/slides/forms + Microsoft
// read/write/office + plaud + credentials + unified) that
// `agent/tools/surface.ts`'s `getFilteredTools` filters FROM. Not
// `agent/tools/registry.ts`'s `registryToolDefinitions()` (same name set,
// deduplicated wrapper for the on-disk docs index) — that pulls in the full
// handler table, which imports every `cat/*.ts` handler including this
// module's own callers, and importing it here would manufacture a real
// import cycle.
//
// WHERE CALLERS GET `allowed` FROM: `getFilteredTools(agentId)` — this
// agent's advertised surface. Suggestions and family listings are drawn
// ONLY from here, never from `known` (R3/R4 below).
//
// ── R5 (OWNER RULING) — GENERIC ACROSS EVERY TOOL, NO FAMILY BRANCHES ──
// The incident's five names are TEST FIXTURES, not special cases. Nothing
// below reads "gmail", "google" or "microsoft" as a string to special-case.
//
// ── WHY THERE IS NO VERB-SYNONYM TABLE HERE (OWNER RULING, WITHDRAWN) ──
// An earlier version of this module scored suggestions with a small table of
// verb near-synonyms (asserting e.g. label ≈ tag ≈ mark ≈ add ≈ update) so
// that a guessed `user_gmail_update` would rank the real `user_gmail_label`
// first. The owner withdrew that requirement: encoding "these words mean
// the same thing" is a SEMANTIC GUESS, not a fact, and it will misfire on a
// tool family nobody has tested it against — a confidently wrong pointer is
// exactly the failure class this task exists to end. `suggestToolNames`
// below is lexical only (containment, shared tokens, edit distance) and
// returns NOTHING when a guess shares no real signal with anything allowed.
//
// The hard cases that scoring alone cannot rescue (`user_gmail_update`,
// `user_gmail_modify` — verb guesses that share no substring and no token
// with the real tool's name) are instead rescued by FAMILY ENUMERATION:
// `describeNameFailure` lists the real tools that share the guess's leading
// segment (`gmail`, `calendar`, `file`, `work`, whatever it is) whenever
// scoring finds nothing worth pointing at. That is a FACT ("here is every
// `user_gmail_*` tool you can call") rather than a guess, and the incident
// agent would have seen the real name in that list.
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

// ── Lexical normalization (no semantic knowledge — see module header) ──────

function normalizeName(name: string): string {
  const lower = name.toLowerCase();
  return lower.startsWith('user_') ? lower.slice('user_'.length) : lower;
}

/** Genuine abbreviations of the SAME word (not a different word with a
 * similar meaning). Kept tiny and literal on purpose. */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  ls: 'list',
  del: 'delete',
};

/** Strips a trailing plural "s" — "labels" and "label" are the SAME token,
 * not a semantic guess. Conservative: leaves short words and double-s
 * endings ("access", "process") alone. */
function singularize(token: string): string {
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

function canonicalToken(token: string): string {
  return singularize(ABBREVIATIONS[token] ?? token);
}

function rawTokens(name: string): string[] {
  return normalizeName(name).split('_').filter(Boolean).map(canonicalToken);
}

/** The tool's family/domain: its leading token once "user_" is stripped —
 * `gmail` for `gmail_update` and for `user_gmail_label`, `work` for
 * `work_update`. A fact read off the name, not a guess about it. */
function familyOf(name: string): string {
  return rawTokens(name)[0] ?? '';
}

/** Every non-family token — the part of the name that names the specific
 * operation/object, once the family segment is set aside. */
function significantTokens(name: string): string[] {
  return rawTokens(name).slice(1);
}

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
  sameFamily: number; // 1 if the leading segment matches, else 0
  sharedSignificant: number; // shared non-family tokens
  distance: number; // edit distance between normalized forms
}

/**
 * Is this candidate's match to `requested` actually EARNED, as opposed to a
 * lexical coincidence? Containment always earns it. Otherwise the candidate
 * must be in the SAME FAMILY as the request AND share at least one
 * significant (non-family) token — sharing only the family segment ("gmail")
 * is not enough on its own (nearly every candidate in a family shares it, so
 * it discriminates nothing), and sharing a significant token ACROSS families
 * (a guessed `gmail_update` coincidentally matching `work_update`'s "update")
 * is exactly the kind of confidently-wrong cross-family pointer this scoring
 * must never produce. A guess with no earned candidate returns no
 * suggestions at all; `describeNameFailure` falls back to family enumeration
 * instead of inventing one.
 */
function isEarnedMatch(c: ScoredCandidate): boolean {
  return c.containment === 1 || (c.sameFamily === 1 && c.sharedSignificant > 0);
}

function scoreCandidate(requestedNorm: string, requestedFamily: string, requestedSignificant: Set<string>, candidate: string): ScoredCandidate {
  const candidateNorm = normalizeName(candidate);
  const containment = (candidateNorm.includes(requestedNorm) || requestedNorm.includes(candidateNorm)) ? 1 : 0;
  const sameFamily = familyOf(candidate) === requestedFamily && requestedFamily !== '' ? 1 : 0;
  const candidateSignificant = significantTokens(candidate);
  const sharedSignificant = new Set(candidateSignificant.filter((t) => requestedSignificant.has(t))).size;
  const distance = editDistance(requestedNorm, candidateNorm);
  return { name: candidate, containment, sameFamily, sharedSignificant, distance };
}

function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.containment !== b.containment) return b.containment - a.containment;
  if (a.sharedSignificant !== b.sharedSignificant) return b.sharedSignificant - a.sharedSignificant;
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.name.length !== b.name.length) return a.name.length - b.name.length; // shorter name wins ties
  return a.name.localeCompare(b.name); // final deterministic tiebreak
}

/**
 * Suggest up to `limit` real tool names close to `requested`, drawn ONLY
 * from `allowed` (R3/R4 — never from `known`; a tool that exists globally
 * but this agent cannot use must never be pointed at as the fix for a
 * naming mistake, that would just trade a naming error for a confusing
 * permission error).
 *
 * Purely lexical: (a) substring/superstring containment of the normalized
 * form, then (b) shared significant-token count within the same family,
 * then (c) edit distance, then (d) shorter name. No candidate outside
 * `isEarnedMatch` is ever returned — a guess that shares nothing but a
 * common family segment, or that happens to share a verb with a tool in a
 * DIFFERENT family, gets no suggestion here. Returns `[]` rather than
 * invent a confident-looking wrong pointer; `describeNameFailure` is what
 * falls back to family enumeration for those cases.
 */
export function suggestToolNames(requested: string, allowed: Set<string>, limit = 3): string[] {
  const requestedNorm = normalizeName(requested);
  const requestedFamily = familyOf(requested);
  const requestedSignificant = new Set(significantTokens(requested));

  const scored: ScoredCandidate[] = [];
  for (const candidate of allowed) {
    if (candidate === requested) continue;
    scored.push(scoreCandidate(requestedNorm, requestedFamily, requestedSignificant, candidate));
  }
  const earned = scored.filter(isEarnedMatch);
  if (earned.length === 0) return [];

  earned.sort(compareScored);
  return earned.slice(0, limit).map((c) => c.name);
}

/**
 * Every tool in `allowed` that shares `requested`'s leading family segment
 * (`gmail`, `calendar`, `file`, `work`, …), sorted for determinism. A FACT,
 * not a guess: no scoring, no tie-breaking, just "these are the real tools
 * in the family you were trying to call." Empty when `requested` has no
 * recognizable family segment or nothing in `allowed` shares it.
 */
export function toolsInSameFamily(requested: string, allowed: Set<string>): string[] {
  const requestedFamily = familyOf(requested);
  if (!requestedFamily) return [];
  const matches: string[] = [];
  for (const candidate of allowed) {
    if (candidate === requested) continue;
    if (familyOf(candidate) === requestedFamily) matches.push(candidate);
  }
  return matches.sort();
}

const FAMILY_LIST_CAP = 8;

/** Formats a family list capped at `FAMILY_LIST_CAP`, with a "+N more" tail
 * when there are more members than that. */
function formatFamilyList(family: string, members: string[]): string {
  const shown = members.slice(0, FAMILY_LIST_CAP);
  const rest = members.length - shown.length;
  const tail = rest > 0 ? `, +${rest} more` : '';
  return `no tool by that name; the "${family}" tools you can call: ${shown.join(', ')}${tail}`;
}

/** The parenthetical pointer for one unknown name: an earned suggestion,
 * else a family listing, else a plain admission nothing close was found. */
function pointerFor(name: string, allowed: Set<string>): string {
  const suggestions = suggestToolNames(name, allowed);
  if (suggestions.length > 0) return `did you mean ${suggestions.join(', ')}?`;
  const family = familyOf(name);
  const familyMembers = toolsInSameFamily(name, allowed);
  if (family && familyMembers.length > 0) return formatFamilyList(family, familyMembers);
  return 'no similar tool name found; the name may simply be wrong';
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
 * For each unknown name it points at an EARNED lexical suggestion when one
 * exists, otherwise the real tools sharing its family, otherwise it says
 * plainly that nothing close was found — never a guessed pointer.
 *
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
    const described = unknownNames.map((name) => `"${name}" (${pointerFor(name, allowed)})`);
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
