// t163 B — WHAT `drive_list` SENDS DRIVE AS ITS `q`.
//
// Drive's `q` is a small query language: `field operator value`, values in single quotes
// (`name contains 'report'`). The tool used to hand the model's text over raw, and its own
// parameter text taught an unquoted example — so a bare word ("ORCHID") and the taught form
// (`name contains ORCHID`) both came back "Invalid Value". A model that types a word is asking
// for a search, not writing Drive syntax: such a query is sent as a full-text search. A query that
// already speaks Drive (a known field followed by an operator, or `'id' in parents`) is the model's
// own and passes through untouched.

const FIELDS = 'name|fullText|mimeType|modifiedTime|createdTime|viewedByMeTime|trashed|starred|parents|owners|writers|readers|sharedWithMe|properties|appProperties|visibility|shortcutDetails\\.targetId';
/** `field <operator>` anywhere outside a quoted value, or a membership test (`'x' in parents`). */
const DRIVE_OPERATOR = new RegExp(`\\b(?:${FIELDS})\\s*(?:contains|has|!=|<=|>=|=|<|>)|\\bin\\s+(?:parents|owners|writers|readers)\\b`);
const QUOTED_VALUE = /'(?:[^'\\]|\\.)*'/g;

/** True when the text already contains a Drive operator expression. */
export function speaksDrive(query: string): boolean {
  return DRIVE_OPERATOR.test(query.replace(QUOTED_VALUE, "''"));
}

/** The `q` for a model-supplied query: Drive syntax as written, anything else a full-text search. */
export function driveSearchQuery(query: string): string {
  const text = query.trim();
  if (text === '' || speaksDrive(text)) return text === '' ? '' : query;
  return `fullText contains '${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
