// t140 round 3: the head of a NOT-YET-CONDENSED placeholder — a deterministic note that stands in for
// rows the view dropped while no summary writer answered (`uncondensed-placeholder.ts`). A leaf module
// so the condenser can recognise one without importing the placeholder machinery. Condensation never
// merges one: it would bury the note where its replacement cannot find it.
export const UNCONDENSED_PLACEHOLDER_HEAD = '[Not yet condensed]';
export const isUncondensedPlaceholder = (content: string): boolean => content.startsWith(UNCONDENSED_PLACEHOLDER_HEAD);
