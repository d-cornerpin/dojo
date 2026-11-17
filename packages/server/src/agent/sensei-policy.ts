// Sensei policy sets: static named sets, one no-import leaf; a hand-edited per-feature list drifts.
// Comms-to-people tools: every tool reaching a person on an owner channel, user_* variants included.
// The Trainer's deny derives from this set, so a listed future comms tool is denied by construction.
// Most are also primary-only gated inside executeToolInner, so this deny is defense-in-depth there.
// Hand-picked: broader than any classifier, it includes non-send comms tools a classifier would miss.
// A conformance test fails unless names resolve, every base tool is here or in the test's not-applicable
// ledger, user_ send twins are denied in parity, and every base name declares reachesPeople (this is its mirror).
export const SEND_TO_PEOPLE: readonly string[] = [
  'gmail_send', 'gmail_reply', 'gmail_forward',
  'user_gmail_send', 'user_gmail_reply', 'user_gmail_forward',
  'outlook_send', 'outlook_reply', 'outlook_forward',
  'user_outlook_send', 'user_outlook_reply', 'user_outlook_forward',
  // The user_ twins send from the owner's personal Teams, so they belong on this deny surface.
  'teams_send_message', 'teams_send_channel_message',
  'user_teams_send_message', 'user_teams_send_channel_message',
  'sms_send',
  'imessage_send', 'imessage_list_contacts',
  'voice_call', 'voice_call_end', 'voice_call_status',
];

// Base send families that generate owner-account user_ twins: the Google and Microsoft channels.
// Twilio SMS/Voice and iMessage have no user-slot twin.
// Deny parity: a denied base send with these prefixes must also deny user_<name>, or the twins leak.
export const USER_TWINNED_SEND_PREFIXES: readonly string[] = ['gmail_', 'outlook_', 'teams_'];

// The owner's identity and config files, consumed two ways: a HARD file_write deny for the Trainer,
// and a destructive-classify signal for the Healer's write, routing it through the approval hold.
// SOUL.md, *-SOUL.md and secrets.yaml are already globally denied, so they need no entry here.
// Matched against the canonicalized, '..'-collapsed target; '*' is one segment, '**' crosses.
export const PROTECTED_IDENTITY_PATHS: readonly string[] = [
  '~/.dojo/prompts/USER.md',
  '~/.dojo/config/**',
  '~/.dojo/*.yaml',
];
