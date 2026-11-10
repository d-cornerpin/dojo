
export const DOJO_VOICE_PREFIX = 'Dojo:';

export function dojoVoice(text: string): string {
  const t = text.trim();
  return t.startsWith(DOJO_VOICE_PREFIX) ? t : `${DOJO_VOICE_PREFIX} ${t}`;
}
