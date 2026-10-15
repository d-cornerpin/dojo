// t172 — is a piece of text NOTHING BUT a row label? The label is the costume the model sees on every
// historical row (`memory/row-label.ts` writes it: `[<instant> · <subject>]`, or the bare `[<instant>]`
// a continued block carries). A model that copies the costume can echo the whole label back as its
// "words". It says nothing, so no note is made of it. The shape is `renderInstant`'s format, then
// optionally ` · ` and a subject that `labelText` has already stripped of brackets.
const LABEL_ONLY_RE =
  /^\[(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}, \d{1,2}:\d{2}[\s  ]?(?:AM|PM)[^[\]·]*(?: · [^[\]]*)?\]$/;

export function isRowLabelOnly(text: string | null | undefined): boolean {
  return typeof text === 'string' && LABEL_ONLY_RE.test(text.trim());
}
