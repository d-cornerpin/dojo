// True when text is only a row label (regex mirrors renderInstant's format): an echo says nothing, no note.
const LABEL_ONLY_RE =
  /^\[(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}, \d{1,2}:\d{2}[\s  ]?(?:AM|PM)[^[\]·]*(?: · [^[\]]*)?\]$/;

export function isRowLabelOnly(text: string | null | undefined): boolean {
  return typeof text === 'string' && LABEL_ONLY_RE.test(text.trim());
}
