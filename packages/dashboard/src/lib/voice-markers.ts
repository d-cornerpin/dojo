const DELIVER_CUE_RE = /^\s*\(\(\s*deliver\s*:\s*[^)]*?\s*\)\)\s*/i;
const PAUSE_MARKER_RE = /\s*\[(?:long\s+)?pause\]\s*/gi;
/** Orb mood marker `((mood: NAME))`: drives the orb's emotion, never shown to the user.
 *  Stripped wherever it appears; agents lead a reply with it. */
const MOOD_MARKER_RE = /\(\(\s*mood\s*:\s*[a-z]+\s*\)\)/gi;

/** Mood name from the last `((mood: NAME))` marker, lowercased; the most recent wins so a
 *  mid-message shift takes over. Emotion validation happens at the call site. */
export function parseMoodMarker(text: string): string | null {
  if (!text) return null;
  let last: string | null = null;
  for (const m of text.matchAll(MOOD_MARKER_RE)) {
    last = m[0].replace(/\(\(\s*mood\s*:\s*/i, '').replace(/\s*\)\)$/, '').trim().toLowerCase();
  }
  return last;
}
/** Engine-control `[no-reply]` sentinel, optionally wrapped in markdown emphasis chars. */
const NO_REPLY_MARKER_RE = /\s*[`*_]*\s*\[no-reply\]\s*[`*_]*\s*/gi;

const TRAILING_PARTIAL_PAUSE_RE =
  /\s*\[(?:long(?:\s+(?:p(?:a(?:u(?:s(?:e)?)?)?)?)?)?|p(?:a(?:u(?:s(?:e)?)?)?)?)?$/i;
const TRAILING_PARTIAL_NO_REPLY_RE =
  /\s*[`*_]*\s*\[n(?:o(?:-(?:r(?:e(?:p(?:l(?:y)?)?)?)?)?)?)?$/i;

export function stripVoiceMarkers(text: string): string {
  if (!text) return text;
  let out = text.replace(MOOD_MARKER_RE, '');
  out = out.replace(DELIVER_CUE_RE, '');
  out = out.replace(NO_REPLY_MARKER_RE, '');
  out = out.replace(PAUSE_MARKER_RE, ' ');
  out = out.replace(/ {2,}/g, ' ');
  out = out.replace(/[ \t]+\n/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

export function stripVoiceMarkersForStream(text: string): string {
  if (!text) return text;
  // Mid-cue: an unclosed "((" hides the whole bubble until "))" arrives.
  if (/^\s*\(\(/.test(text) && !/\)\)/.test(text)) return '';
  let out = stripVoiceMarkers(text);
  out = out.replace(TRAILING_PARTIAL_PAUSE_RE, '');
  out = out.replace(TRAILING_PARTIAL_NO_REPLY_RE, '');
  return out.trimEnd();
}
