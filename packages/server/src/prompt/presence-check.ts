// A presence-only message is labelled in the turn context so the agent answers it and recaps nothing.
const PRESENCE = /^(?:(?:are\s+)?you\s+(?:there|around|still\s+there|here)|still\s+there|anyone\s+(?:there|home)|hello|hi|hey|ping|yo)[\s?!.]*$/i;

export function isPresenceCheck(text: string | null | undefined): boolean {
  return PRESENCE.test(String(text ?? '').trim());
}

export const PRESENCE_HINT =
  '## This message only checks that you are here\n' +
  'Answer that you are, in a few words. Nothing else was asked: do not recap tasks, results or news already given.';
