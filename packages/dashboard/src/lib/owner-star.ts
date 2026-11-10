// The starred entry is the owner and never moves itself; an owner-change save must send ownerChange.

export const ownerKey = (list: ReadonlyArray<{ address: string; is_primary?: boolean }>): string =>
  list.filter((s) => s.is_primary === true).map((s) => s.address.trim().toLowerCase()).sort().join('|');

export const ownerChanged = (
  before: ReadonlyArray<{ address: string; is_primary?: boolean }>,
  after: ReadonlyArray<{ address: string; is_primary?: boolean }>,
): boolean => ownerKey(before) !== ownerKey(after);

export const confirmRemoveOwner = (label: string): boolean =>
  window.confirm(`${label} is marked as you, the owner. Removing it leaves your list with no owner until you star someone again, and with no owner marked the watchdog will text nobody. Remove it anyway?`);
