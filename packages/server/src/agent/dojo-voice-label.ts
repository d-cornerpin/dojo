// The "Dojo:" label, as a LEAF (it imports nothing), so a module that only builds engine words can
// label them without pulling the notice machinery in. `agent/dojo-voice.ts` re-exports both; there is
// one definition. OR-ENGINE-LABELLED (owner, 2026-10-31): engine words to a person are plainly the Dojo.

/** The label every engine-spoken message to a person starts with. */
export const DOJO_VOICE_PREFIX = 'Dojo:';

/** The text as the Dojo speaking: starts with "Dojo:" (added once, never doubled). */
export function dojoVoice(text: string): string {
  const t = text.trim();
  return t.startsWith(DOJO_VOICE_PREFIX) ? t : `${DOJO_VOICE_PREFIX} ${t}`;
}
