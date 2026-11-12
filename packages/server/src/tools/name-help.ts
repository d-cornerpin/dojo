// Name-help: a never-real tool name is a NAMING problem (fix the spelling, call `load_tool_docs`); a
// real name withheld from THIS agent is a PERMISSION problem (escalate). The recoveries are opposite.
// A pure leaf (no registry, surface or handler imports, so no cycle): callers pass `allowed`
// (`getFilteredTools(agentId)`) and `known` (`getAllToolDefinitions()`, not `registry.ts`, whose
// handler table imports this module's own callers). Suggestions come only from `allowed`.
// Generic across every tool, and no verb-synonym table: synonyms are a guess that misfires on untested
// families. Suggestions are lexical; family enumeration (a fact) covers the rest.

export type ToolNameVerdict = 'allowed' | 'exists_not_allowed' | 'unknown';

/** `allowed` is checked first so a stale or partial `known` set still answers right for usable names. */
export function classifyToolName(requested: string, allowed: Set<string>, known: Set<string>): ToolNameVerdict {
  if (allowed.has(requested)) return 'allowed';
  if (known.has(requested)) return 'exists_not_allowed';
  return 'unknown';
}


function normalizeName(name: string): string {
  const lower = name.toLowerCase();
  return lower.startsWith('user_') ? lower.slice('user_'.length) : lower;
}

const ABBREVIATIONS: Readonly<Record<string, string>> = {
  ls: 'list',
  del: 'delete',
};

function singularize(token: string): string {
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

export function canonicalToken(token: string): string {
  return singularize(ABBREVIATIONS[token] ?? token);
}

function rawTokens(name: string): string[] {
  return normalizeName(name).split('_').filter(Boolean).map(canonicalToken);
}

function familyOf(name: string): string {
  return rawTokens(name)[0] ?? '';
}

function significantTokens(name: string): string[] {
  return rawTokens(name).slice(1);
}

export function editDistance(a: string, b: string): number {
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
  containment: number;
  sameFamily: number;
  sharedSignificant: number;
  distance: number;
}

/** Is the match earned? Containment, or same family AND a shared non-family token; a token shared across
 *  families (`gmail_update` vs `work_update`) is the confidently wrong pointer this must never produce. */
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
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  return a.name.localeCompare(b.name);
}

/** Up to `limit` close names drawn only from `allowed` (a tool this agent cannot use is never the fix
 *  for a misspelling). Lexical, and `[]` rather than a confident-looking wrong pointer. */
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

/** A family list capped at `FAMILY_LIST_CAP`, "+N more" tail. Wording claims only a shared prefix,
 *  never kinship ("set" is just a shared verb). */
function formatFamilyList(family: string, members: string[]): string {
  const shown = members.slice(0, FAMILY_LIST_CAP);
  const rest = members.length - shown.length;
  const tail = rest > 0 ? `, +${rest} more` : '';
  return `no tool by that name; tools whose names start with "${family}_": ${shown.join(', ')}${tail}`;
}

function pointerFor(name: string, allowed: Set<string>): string {
  const suggestions = suggestToolNames(name, allowed);
  if (suggestions.length > 0) return `did you mean ${suggestions.join(', ')}?`;
  const family = familyOf(name);
  const familyMembers = toolsInSameFamily(name, allowed);
  if (family && familyMembers.length > 0) return formatFamilyList(family, familyMembers);
  return 'no similar tool name found; the name may simply be wrong';
}

/**
 * The shared text every tool-name-failure call site emits. Unknown and exists-but-not-allowed names
 * are reported separately; the unknown group never carries permission language. An `allowed` name
 * here still failed to dispatch, so it is named with a next step, never silence.
 */
export function describeNameFailure(requested: string[], allowed: Set<string>, known: Set<string>): string {
  const unknownNames: string[] = [];
  const notAllowedNames: string[] = [];
  const allowedNames: string[] = [];
  for (const name of requested) {
    const verdict = classifyToolName(name, allowed, known);
    if (verdict === 'unknown') unknownNames.push(name);
    else if (verdict === 'exists_not_allowed') notAllowedNames.push(name);
    else allowedNames.push(name);
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
      ? 'Ask the owner to update this agent\'s permissions, or call complete_task(status="blocked").'
      : 'Ask the owner to update this agent\'s permissions, use send_to_agent to reach an agent with broader permissions, or tell the person you are talking to you are blocked.';
    sentences.push(
      `${plural ? 'These tools exist but are not accessible to this agent' : 'This tool exists but is not accessible to this agent'}: ${notAllowedNames.join(', ')}. ` +
      'This is a permission issue, not a format issue: the tool(s) may exist for other agents but are not on this agent\'s allow list, or a permission filter is stripping them ' +
      '(e.g. web_search/web_fetch require network_domains != "none", exec requires exec_allow non-empty, file_read requires file_read permission). ' +
      escalation,
    );
  }

  // Every requested name classified `allowed`: dispatch itself failed, so name it rather than answer "".
  if (sentences.length === 0 && allowedNames.length > 0) {
    const plural = allowedNames.length > 1;
    sentences.push(
      `${plural ? 'These tool names appear allowed for this agent' : 'This tool name appears allowed for this agent'} but failed to dispatch: ${allowedNames.join(', ')}. ` +
      'This is an engine defect, not a naming or permission problem: the tool is on this agent\'s allow list and should have run. ' +
      'Retry the call once; if it fails again the same way, report the tool name to the person you are talking to rather than guessing at a workaround.',
    );
  }

  return sentences.join(' ');
}
