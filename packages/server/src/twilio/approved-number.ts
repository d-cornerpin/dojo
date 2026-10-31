// The owner's approved-number check for outbound texts and calls.
// A number is approved only when it is the SAME number as a saved entry once formatting is
// removed. No substring or partial match: "0198" or "1" never approves anything.
// The caller then uses the SAVED number, never the text the agent typed.

export interface ApprovedEntry { name: string; address: string }

/** Digits only, with a bare 10-digit number read as a US number (+1). Null when it is not a phone number. */
export function normalisePhone(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return null;
  let digits = s.replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  return digits.length >= 8 ? digits : null;
}

export function findApprovedNumber<T extends ApprovedEntry>(list: readonly T[], typed: string): T | null {
  const want = normalisePhone(typed);
  if (!want) return null;
  return list.find((e) => normalisePhone(e.address) === want) ?? null;
}
