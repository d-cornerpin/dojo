const FIELDS = 'name|fullText|mimeType|modifiedTime|createdTime|viewedByMeTime|trashed|starred|parents|owners|writers|readers|sharedWithMe|properties|appProperties|visibility|shortcutDetails\\.targetId';
const DRIVE_OPERATOR = new RegExp(`\\b(?:${FIELDS})\\s*(?:contains|has|!=|<=|>=|=|<|>)|\\bin\\s+(?:parents|owners|writers|readers)\\b`);
const QUOTED_VALUE = /'(?:[^'\\]|\\.)*'/g;

/** The query with quoted values emptied, so a word inside a value is not read as Drive syntax. */
export function withoutQuotedValues(query: string): string {
  return query.replace(QUOTED_VALUE, "''");
}

export function speaksDrive(query: string): boolean {
  return DRIVE_OPERATOR.test(withoutQuotedValues(query));
}

/** Drive syntax passes through; other text (a bare word fails as Invalid Value) is a full-text search. */
export function driveSearchQuery(query: string): string {
  const text = query.trim();
  if (text === '' || speaksDrive(text)) return text === '' ? '' : query;
  return `fullText contains '${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
