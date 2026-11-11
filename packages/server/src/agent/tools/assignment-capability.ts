// Checks tool NAMES written verbatim in an assignment's text against the assignee's grants.
// Counts names, never classifies intent from prose. Warns, never refuses: passing mentions are common.

import { toolDefinitions } from './definitions.js';
import { toolCategoryGranted } from '../access/read.js';
import { heldGroupsClause } from './held-groups.js';

export const MISMATCH_NAMED_MAX = 6;

// Longest first: a shorter name that is a prefix of a longer one must not shadow it in the match.
let vocabulary: string[] | null = null;
function toolVocabulary(): string[] {
  if (!vocabulary) {
    vocabulary = toolDefinitions.map((t) => t.name)
      .filter((n) => typeof n === 'string' && n.length >= 4)
      .sort((a, b) => b.length - a.length);
  }
  return vocabulary;
}

// Word boundaries are the whole safety: a substring match would hit `file_read` inside `profile_reader`.
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
  missing: string[];
  /** Named and callable; carried so a caller can say which named tools are fine. */
  granted: string[];
}

/** `toolCategoryGranted` is the executor's own predicate: a reported miss is one the gate refuses. */
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

/** Ends with `heldGroupsClause`, the same clause the executor's refusal carries, told in one voice. */
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
