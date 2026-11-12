// The one annotated tool-index entry: the cached index is names only, and `dojo_report` is the one tool
// measured to go unreached without a phrase. Every byte here rides the cached prefix, so each new entry
// costs a deliberate golden re-record.

export const INDEX_NOTES: Readonly<Record<string, string>> = {
  dojo_report: 'report a problem with the Dojo itself to the people who build it',
};

// `name`, or `name` (what it is for) when annotated. The annotation rides the NAME, not the category,
// so an agent whose index does not list the annotated tool gets a byte-identical line.
export function renderIndexName(name: string): string {
  const note = Object.hasOwn(INDEX_NOTES, name) ? INDEX_NOTES[name] : undefined;
  return note === undefined ? `\`${name}\`` : `\`${name}\` (${note})`;
}
