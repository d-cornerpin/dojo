// A summary is not a second ledger: this reads the work id the summariser cites (`memory/summarize.ts`), at WRITE,
// once, into the stored text (summaries ride the cacheable prefix, so render reads the row as stored). It ANNOTATES,
// never rewrites: the finding is bracketed on the same line. It never guesses: an id line needs a literal join token
// (`cmt:<hex>` or `promise-<runid>`); an id-less line needs obligation prose, a counterparty AND a deliverable on the
// agent's own spine rows, and no open row. `work/obligation-memory.ts` is the ONE resolver.

import {
  obligationTags, obligationVerdict,
  idlessObligationVerdict, commitmentVocabularyFor, type RowVocabulary,
} from '../work/obligation-memory.js';

/** The opening of the engine's appended finding: one literal, so writer, idempotence check and tests agree. */
export const SUMMARY_OBLIGATION_MARK = '[work state as of ';

/** A line naming a known counterparty but no recorded deliverable: says only that nothing LIVE matches. */
export const SUMMARY_NO_MATCH_MARK = '[historical note — no live commitment matches]';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function findingFor(line: string): string | null {
  if (obligationTags(line).length === 0) return null;
  const verdict = obligationVerdict(line);
  switch (verdict.kind) {
    case 'closed':
      return `${SUMMARY_OBLIGATION_MARK}${today()}: ${verdict.states.join('/')}]`;
    case 'live':
      return `${SUMMARY_OBLIGATION_MARK}${today()}: open]`;
    case 'unresolvable':
      // Not dead, unknown: declaring a record dead because it was not found makes a memory a lie.
      return `${SUMMARY_OBLIGATION_MARK}${today()}: no matching record on the work spine — `
        + 'verify before repeating as owed]';
    case 'not-an-obligation':
    default:
      return null;
  }
}

/** The finding for a line the model gave NO id, or null. It NAMES the matched row: a name match is an
 *  inference, and one the reader cannot check is a lie. */
function idlessFindingFor(line: string, agentId: string, vocab: RowVocabulary[]): string | null {
  const verdict = idlessObligationVerdict(line, agentId, vocab);
  switch (verdict.kind) {
    case 'closed':
      return `${SUMMARY_OBLIGATION_MARK}${today()}: ${verdict.states.join('/')} — matched by name to `
        + `${verdict.workIds.length} commitment row(s), newest ${verdict.newest}]`;
    case 'unmatched':
      return SUMMARY_NO_MATCH_MARK;
    case 'live':          // still owed: the line is TRUE and stays as written
    case 'not-an-obligation':
    default:
      return null;
  }
}

/** Resolve every obligation line against the spine. Line-oriented (the annotation belongs to the item) and
 *  idempotent by the mark, so the write path and the hygiene pass can both run over the same text. */
export function annotateSummaryObligations(text: string, agentId?: string): string {
  if (!text) return text;
  // The id-less leg is agent-scoped (a spine belongs to one agent); without an agent only id-cited lines resolve.
  const vocab = agentId ? commitmentVocabularyFor(agentId) : [];
  if (vocab.length === 0 && !text.includes('cmt:') && !text.includes('promise-')) return text;
  let changed = false;
  const out = text.split('\n').map((line) => {
    const already = splitTrailingFinding(line);
    if (already) {
      // A leading finding is returned untouched, which keeps the pass idempotent.
      changed = true;
      return withLeadingFinding(already.rest, already.finding);
    }
    if (line.includes(SUMMARY_OBLIGATION_MARK) || line.includes(SUMMARY_NO_MATCH_MARK)) return line;
    const finding = findingFor(line)
      ?? (agentId && vocab.length > 0 ? idlessFindingFor(line, agentId, vocab) : null);
    if (!finding) return line;
    changed = true;
    return withLeadingFinding(line, finding);
  });
  return changed ? out.join('\n') : text;
}

// The finding goes first in the line's own text, AFTER the markdown list marker: in front of a `- ` it would break
// the list item, and a marker nobody can see is not louder.

const LEADING_STRUCTURE_RE = /^(\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s+)*)/;

function withLeadingFinding(line: string, finding: string): string {
  const lead = LEADING_STRUCTURE_RE.exec(line)?.[1] ?? '';
  const body = line.slice(lead.length).trimStart();
  return body.length > 0 ? `${lead}${finding} ${body}` : `${lead}${finding}`;
}

/** A line this module already annotated, split into its words and its finding, so a finding written earlier is
 *  MOVED, not duplicated. The finding always ends the line; null when there is none or it is already leading. */
function splitTrailingFinding(line: string): { rest: string; finding: string } | null {
  const at = Math.max(line.lastIndexOf(SUMMARY_OBLIGATION_MARK), line.lastIndexOf(SUMMARY_NO_MATCH_MARK));
  if (at < 0 || !line.trimEnd().endsWith(']')) return null;
  const lead = LEADING_STRUCTURE_RE.exec(line)?.[1] ?? '';
  if (at === lead.length) return null;                      // already leading
  const rest = line.slice(0, at).trimEnd();
  if (rest.length <= lead.length) return null;              // nothing but the finding on the line
  return { rest, finding: line.slice(at).trimEnd() };
}
