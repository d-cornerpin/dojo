// ════════════════════════════════════════════════════════════════════════════════════════
// services/outlook-owner-gate.ts — is an Outlook email ever confirmed as the owner's? (P44, review R1)
//
// YES, since live check C3 (2026-10-31, overhaul-plans/v35-live-checks-status.md). Exchange Online's real topmost
// `Authentication-Results` header on a delivered message reads `mx.microsoft.com 1; spf=...; dkim=...; dmarc=pass action=none
// header.from=<domain>;compauth=pass reason=100`, the same shape from an external Gmail sender, an external Microsoft 365 sender and
// a self-send. The verdict (`mail-owner-verdict.ts`) accepts that authserv-id, with or without the version token. Same-tenant
// internal mail was not covered by the check: if it carries no Microsoft-stamped topmost header it stays unconfirmed (fail closed).
// ════════════════════════════════════════════════════════════════════════════════════════

/** True: a real Exchange header has been checked (live check C3, 2026-10-31). */
export function outlookOwnerConfirmationOpen(): boolean {
  return true;
}
