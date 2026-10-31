// ════════════════════════════════════════════════════════════════════════════════════════
// services/outlook-owner-gate.ts — is an Outlook email ever confirmed as the owner's? (P44, review R1)
//
// NOT YET. What Exchange Online's own `Authentication-Results` header looks like on a delivered message (whether it
// carries an authserv-id at all, and which) has not been checked against a real message on the dev box. Until it has,
// "the header the provider wrote" cannot be told from one the sender wrote, so Outlook owner confirmation fails
// CLOSED: every Outlook email is unconfirmed. The parser and its tests stay; opening this gate is one line, made only
// after a real delivered header (external, same-domain, same-tenant) has been read and the verdict's Microsoft shape set.
// ════════════════════════════════════════════════════════════════════════════════════════

/** False until a real Exchange header has been checked on the dev box (release gate I5). */
export function outlookOwnerConfirmationOpen(): boolean {
  return false;
}
