// t182 — a message that only checks the agent is there ("You there?", "hello?") asked nothing else. Run 10, 15 and
// 16 S2: on "You there?" the agent recapped open work and results already given, and the owner heard them again.
// The turn context SAYS what the message is (label, not hide): answer presence, recap nothing.
const PRESENCE = /^(?:(?:are\s+)?you\s+(?:there|around|still\s+there|here)|still\s+there|anyone\s+(?:there|home)|hello|hi|hey|ping|yo)[\s?!.]*$/i;

/** True when the whole message is a presence check (punctuation and spacing aside). */
export function isPresenceCheck(text: string | null | undefined): boolean {
  return PRESENCE.test(String(text ?? '').trim());
}

export const PRESENCE_HINT =
  '## This message only checks that you are here\n' +
  'Answer that you are, in a few words. Nothing else was asked: do not recap tasks, results or news already given.';
