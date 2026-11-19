// Sensei policy sets: static named sets the Trainer, the Healer and the channel grants read.
import { PEOPLE_TOOLS } from '@dojo/shared';

// Base send families that generate owner-account user_ twins: the Google and Microsoft channels.
// Twilio SMS/Voice and iMessage have no user-slot twin.
export const USER_TWINNED_SEND_PREFIXES: readonly string[] = ['gmail_', 'outlook_', 'teams_'];

// Comms-to-people tools: every tool of the shared table (`PEOPLE_TOOLS`), the reads included, plus the user_
// twin of each twinned one. The Trainer and Healer deny lists and the helpers' channel grants derive from it.
export const SEND_TO_PEOPLE: readonly string[] = [...PEOPLE_TOOLS.keys()].flatMap((name) =>
  USER_TWINNED_SEND_PREFIXES.some((p) => name.startsWith(p)) ? [name, `user_${name}`] : [name]);

// The owner's identity and config files, consumed two ways: a HARD file_write deny for the Trainer,
// and a destructive-classify signal for the Healer's write, routing it through the approval hold.
// SOUL.md, *-SOUL.md and secrets.yaml are already globally denied, so they need no entry here.
// Matched against the canonicalized, '..'-collapsed target; '*' is one segment, '**' crosses.
export const PROTECTED_IDENTITY_PATHS: readonly string[] = [
  '~/.dojo/prompts/USER.md',
  '~/.dojo/config/**',
  '~/.dojo/*.yaml',
];
