// ════════════════════════════════════════
// Sensei policy sets (FU-4).
//
// Two STATIC, named sets that the sensei permission model derives from, kept in
// one leaf module (no imports) so there is a single source of truth and no
// import cycle. The FU-4 root cause is a hand-maintained allow-list that
// silently under-grants a trusted, open-ended agent every time a new tool ships;
// the mirror-image failure is a hand-maintained DENY-list that silently
// UNDER-blocks when a new dangerous tool ships. Both are avoided by classifying
// against a stable named set instead of remembering to edit a list per feature.
// ════════════════════════════════════════

/**
 * Comms-to-people tools: every tool that reaches a real person on one of the
 * owner's channels (email / Teams / SMS / iMessage / voice), including the
 * user-slot (`user_*`) send/reply/forward variants. This is the single named
 * set the Trainer's deny-list derives from, so a FUTURE comms tool is denied by
 * construction, add it here and the Trainer refresh picks it up on the next boot
 * (ensureTrainerAgentRunning rewrites tools_policy every boot). The set is the
 * whole comms-to-people surface (sends plus the auxiliary contact-list / call
 * lifecycle + status tools on those channels), matching the owner decision to
 * block the Trainer from the owner's comms-to-people channels while keeping
 * send_to_agent and in-chat replies.
 *
 * NOTE: most of these are ALSO hard primary-only gated inside executeToolInner
 * today (imessage/sms/voice at the dispatch guards; the Google/Microsoft write
 * tools at their belt-and-suspenders isPrimaryAgent checks), so the deny is
 * defense-in-depth for the ones that are already gated and the real enforcement
 * for any that are not. Listing every one keeps the surface honest.
 */
export const SEND_TO_PEOPLE: readonly string[] = [
  // Gmail (agent slot + user slot)
  'gmail_send', 'gmail_reply', 'gmail_forward',
  'user_gmail_send', 'user_gmail_reply', 'user_gmail_forward',
  // Outlook (agent slot + user slot)
  'outlook_send', 'outlook_reply', 'outlook_forward',
  'user_outlook_send', 'user_outlook_reply', 'user_outlook_forward',
  // Microsoft Teams
  'teams_send_message', 'teams_send_channel_message',
  // Twilio SMS
  'sms_send',
  // iMessage
  'imessage_send', 'imessage_list_contacts',
  // Twilio Voice
  'voice_call', 'voice_call_end', 'voice_call_status',
];

/**
 * The owner's identity + platform-config files. ONE static prefix set, consumed
 * TWO ways:
 *  - a HARD file_write deny for the Trainer (permissions.ts checkPermission),
 *    which now holds broad file_write '*' for technique work but must never
 *    touch the owner's profile/config; and
 *  - a destructive-classify signal for the Healer (destructive-gate.ts), whose
 *    full primary-equivalent write grant makes a write here a new destructive
 *    path that routes through the approval hold rather than a free write.
 *
 * SOUL.md, every *-SOUL.md, and secrets.yaml are ALREADY covered by
 * permissions.ts GLOBAL_FILE_WRITE_DENY (writes) and GLOBAL_EXEC_DENY_SUBSTRINGS
 * (shell), so they need no entry here. Patterns are matched by
 * isProtectedIdentityPath (permissions.ts) against the canonicalized,
 * '..'-collapsed target, so a traversal cannot slip the prefix match.
 *
 * Glob semantics (permissions.ts matchGlob): `*` matches within one path
 * segment, `**` crosses segments. `~/.dojo/*.yaml` therefore covers the loose
 * config yamls directly under ~/.dojo (secrets.yaml matches too, harmless: it is
 * already globally denied), while nested config lives under `~/.dojo/config/**`.
 */
export const PROTECTED_IDENTITY_PATHS: readonly string[] = [
  '~/.dojo/prompts/USER.md',
  '~/.dojo/config/**',
  '~/.dojo/*.yaml',
];
