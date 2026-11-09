// approved legacy default-sender, else the starred owner; never the first entry: removal is deliberate.

export type ApprovedSender = { address: string; is_primary?: boolean };

export const normAddr = (s: string): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9@.]/g, '').replace(/^1(\d{10})$/, '$1');

export function chooseOwnerRecipient(approved: readonly ApprovedSender[], candidate: string | null | undefined): string {
  if (candidate && approved.some((s) => normAddr(s.address) === normAddr(candidate))) return candidate;
  return approved.find((s) => s.is_primary === true)?.address ?? '';
}
