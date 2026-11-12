// Approved-number check for outbound texts and calls: exact match after formatting, never partial.

import { ownerIMessageRecords } from '../services/safe-senders.js';

export interface ApprovedEntry { name: string; address: string }

/** Digits only, with a bare 10-digit number read as a US number (+1). Null when it is not a phone number. */
export function normalisePhone(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return null;
  let digits = s.replace(/\D/g, '');
  // 00/011 dial prefixes mean "+"; no real number starts with 0, so stripping never yields a different line.
  if (!s.startsWith('+')) digits = digits.replace(/^(?:00|011)(?=[1-9])/, '');
  if (digits.length === 10) digits = '1' + digits;
  return digits.length >= 8 ? digits : null;
}

export function findApprovedNumber<T extends ApprovedEntry>(list: readonly T[], typed: string): T | null {
  const want = normalisePhone(typed);
  if (!want) return null;
  return list.find((e) => normalisePhone(e.address) === want) ?? null;
}

/** List first, then the owner's number(s); callers use the returned SAVED entry. Null if no exact match. */
export function resolveRecipient(list: readonly ApprovedEntry[], typed: string): ApprovedEntry | null {
  const listed = findApprovedNumber(list, typed);
  if (listed) return listed;
  let owners: ApprovedEntry[] = [];
  try { owners = ownerIMessageRecords(); } catch { /* owner unknown: only the list applies */ }
  return findApprovedNumber(owners, typed);
}
