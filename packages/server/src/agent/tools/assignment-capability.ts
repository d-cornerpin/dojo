// ════════════════════════════════════════════════════════════════════════════════
// AN ASSIGNMENT THE ASSIGNEE CANNOT PERFORM, CAUGHT BEFORE THE RUN.
// (t90 D3, second half — live-test report #4)
//
// ── THE REPORT ──
// *"A sub-agent was spawned for a small local task whose entire purpose was to write a single
// short line into a file in the owner's home directory. Its instructions told it to use file
// tools. The agent attempted a file-write tool first; the call was refused by a permission gate
// because the tool's group was not in the agent's grants. It then attempted the same effect via
// the shell tool; that was refused by the same gate, for the same reason. The task was therefore
// unrunnable end to end."* And its diagnosis, which is the design brief for this file: *"The
// assigned work and the agent's grants were decided independently and never cross-checked. The
// spawn path carries the task text and the grant set as separate concerns."*
//
// ── COUNTING, NOT CLASSIFYING — THE LINE THIS FILE STAYS ON ──
// The report's own fix idea starts *"if the task description implies filesystem or shell work"*,
// and that phrasing is a trap this codebase has a standing rule against: the round-11 NOT-DOING
// list bans engine punt-detection, and `work/join-drive.ts` states the general form — *"the engine
// may count structure and may not classify reply prose"*. Guessing intent from prose is exactly
// the banned class, and it would be wrong in both directions (a task saying "write up the results"
// needs no file tool; one saying "handle the thing we discussed" may need every tool there is).
//
// So this module never reads intent. It matches TOOL NAMES, which are a closed vocabulary minted
// in exactly one place (`definitions.ts`), against the words the spawner actually wrote. A name
// from a fixed list appearing verbatim in an instruction is STRUCTURE — the same kind of fact as a
// row count — and the report's own run is the proof it is the right signal: *"Its instructions told
// it to use file tools."* The spawner named the tools. Nobody had to infer anything.
//
// ── WARN, DO NOT REFUSE, AND THE ARGUMENT IS THE REPORT'S OWN ──
// The report offers both: *"either widen the grant or refuse the assignment with a clear message
// to whoever dispatched it"*. This warns, for three reasons, in order of weight:
//
//   1. A refusal would break legitimate spawns. Instructions mention tool names in passing all the
//      time — "don't bother with web_search for this", "the output of file_read is already in your
//      brief" — and a spawn that dies on a word in a sentence is a worse failure than the one being
//      fixed, with no way for the spawner to proceed.
//   2. The spawner is an AGENT, mid-turn, holding the grant verbs. A warning in its tool result is
//      something it can act on immediately — widen the grant, pick a different assignee, or reword
//      the task — which is precisely the "clear message to whoever dispatched it" the report asks
//      for, delivered to someone who can do something about it.
//   3. The platform's own gates have not changed. If the mismatch is real the executor still
//      refuses the call — and since t90's first half that refusal names what the agent DOES hold.
//      This check buys the mismatch being visible BEFORE the turns are spent; it does not need to
//      be the wall as well.
// ════════════════════════════════════════════════════════════════════════════════

import { toolDefinitions } from './definitions.js';
import { toolCategoryGranted } from '../access/read.js';
import { heldGroupsClause } from './held-groups.js';

/** How many missing tools the warning names before it stops listing. */
export const MISMATCH_NAMED_MAX = 6;

/**
 * Every tool name the platform can mint, longest first.
 *
 * Longest-first matters: `file_read` must be found before `file_read_lines` would be matched as
 * `file_read` plus noise, and a shorter name that is a prefix of a longer one must not shadow it.
 * Built once — `toolDefinitions` is a module constant and cannot change at runtime.
 */
let vocabulary: string[] | null = null;
function toolVocabulary(): string[] {
  if (!vocabulary) {
    vocabulary = toolDefinitions.map((t) => t.name)
      .filter((n) => typeof n === 'string' && n.length >= 4)
      .sort((a, b) => b.length - a.length);
  }
  return vocabulary;
}

/**
 * The tool names this text actually names, matched on WORD BOUNDARIES.
 *
 * The boundary rule is the whole safety of this function, and it is the lesson t87 paid for in the
 * provider classifier: a substring match treats `file_read` inside `profile_reader` as a hit. Here
 * the delimiters are the ones prose and code both use, and a name must be surrounded by them.
 */
export function namedTools(text: string | null | undefined): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const name of toolVocabulary()) {
    const at = new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`).test(lower);
    if (at) found.push(name);
  }
  return found;
}

export interface MismatchResult {
  /** Named in the assignment and NOT callable by the assignee. */
  missing: string[];
  /** Named and callable — carried so a caller can say "these are fine" if it ever wants to. */
  granted: string[];
}

/**
 * Which of the tools this assignment NAMES the assignee cannot call.
 *
 * `toolCategoryGranted` is the executor's own predicate — the same function row 17 of the gate and
 * the surface strip both ask — so a tool this reports as missing is a tool that would genuinely be
 * refused, and one it stays quiet about is one the agent can genuinely call. Asking the gate's own
 * question rather than re-deriving it is why this cannot drift into a false warning.
 */
export function assignmentCapabilityMismatch(agentId: string, texts: ReadonlyArray<string | null | undefined>): MismatchResult {
  const named = [...new Set(texts.flatMap((t) => namedTools(t)))];
  const missing: string[] = [];
  const granted: string[] = [];
  for (const tool of named) {
    try {
      if (toolCategoryGranted(agentId, tool)) granted.push(tool);
      else missing.push(tool);
    } catch {
      // An unreadable grant record is not a mismatch: the safe direction here is silence, because
      // a false warning on every spawn would teach the spawner to ignore the real ones.
      granted.push(tool);
    }
  }
  return { missing, granted };
}

/**
 * The sentence appended to the spawner's own tool result, or `''` when there is nothing to say.
 *
 * It names the tools, says who cannot call them, and ends with what the assignee DOES hold —
 * reusing `heldGroupsClause`, the same sentence the executor's refusal now carries, so the spawner
 * and the spawned agent are told the same thing in the same words.
 */
export function mismatchWarning(p: {
  agentId: string; agentName: string; texts: ReadonlyArray<string | null | undefined>;
}): string {
  const { missing } = assignmentCapabilityMismatch(p.agentId, p.texts);
  if (missing.length === 0) return '';
  const named = missing.slice(0, MISMATCH_NAMED_MAX);
  const rest = missing.length - named.length;
  return `\n⚠ CAPABILITY MISMATCH: this assignment names ${named.join(', ')}`
    + `${rest > 0 ? ` (+${rest} more)` : ''}, which ${p.agentName} cannot call.`
    + ` The run will fail at the first attempt unless you widen the grant, reassign the work, or`
    + ` reword the task.${heldGroupsClause(p.agentId)}`;
}
