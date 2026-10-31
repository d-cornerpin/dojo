// Who the watchdog may text. Pure, so it can be driven (index.ts starts a daemon at import).
//
// Owner ruling: the owner star never moves on its own, and an owner may remove it on purpose. So the
// watchdog texts (1) the legacy default-sender address if it is an approved sender (the owner's own
// designation, which the dashboard clears when the owner entry is removed), else (2) the STARRED entry.
// It never falls back to the first entry: with no owner it texts nobody. (A bare-address list's first
// entry is its documented old owner form; the caller marks it starred before it gets here.)

export type ApprovedSender = { address: string; is_primary?: boolean };

export const normAddr = (s: string): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9@.]/g, '').replace(/^1(\d{10})$/, '$1');

export function chooseOwnerRecipient(approved: readonly ApprovedSender[], candidate: string | null | undefined): string {
  if (candidate && approved.some((s) => normAddr(s.address) === normAddr(candidate))) return candidate;
  return approved.find((s) => s.is_primary === true)?.address ?? '';
}
