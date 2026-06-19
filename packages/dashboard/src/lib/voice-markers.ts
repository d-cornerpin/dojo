/**
 * Strip engine control markers + voice-mode cues from displayed text.
 * Used by every AssistantBubble when wordyMode is off so the chat
 * reads like normal prose, while wordy mode shows the raw agent
 * output with the markers visible.
 *
 * Markers handled:
 *   - Leading ((deliver: ...)) cue line (matches case-insensitively)
 *   - Inline [pause] and [long pause] markers
 *   - [no-reply] sentinel anywhere in the bubble (with optional
 *     surrounding markdown wrappers like backticks or asterisks, same
 *     shape the server's persistence layer strips at end-of-message)
 *
 * The functions also handle in-flight streaming: if a cue or marker
 * is still arriving mid-stream, the partial fragment is hidden
 * rather than briefly flashed to the user.
 */

const DELIVER_CUE_RE = /^\s*\(\(\s*deliver\s*:\s*[^)]*?\s*\)\)\s*/i;
const PAUSE_MARKER_RE = /\s*\[(?:long\s+)?pause\]\s*/gi;
/** Orb mood marker `((mood: NAME))` — drives the orb's emotion, never shown to
 *  the user. Stripped anywhere it appears (agents lead a reply with it). */
const MOOD_MARKER_RE = /\(\(\s*mood\s*:\s*[a-z]+\s*\)\)/gi;

/**
 * Pull the mood name out of the last `((mood: NAME))` marker in the text (the
 * most recent one wins so a mid-message shift takes over), lowercased; null if
 * none. Validation against the orb's known emotions happens at the call site.
 */
export function parseMoodMarker(text: string): string | null {
  if (!text) return null;
  let last: string | null = null;
  for (const m of text.matchAll(MOOD_MARKER_RE)) {
    last = m[0].replace(/\(\(\s*mood\s*:\s*/i, '').replace(/\s*\)\)$/, '').trim().toLowerCase();
  }
  return last;
}
/** Engine-control `[no-reply]` sentinel, optionally wrapped in markdown emphasis (backtick / asterisk / underscore). */
const NO_REPLY_MARKER_RE = /\s*[`*_]*\s*\[no-reply\]\s*[`*_]*\s*/gi;

/**
 * Trailing partial pause-marker — matches a bracket that's started but
 * not yet closed (e.g. "[pa", "[long pause", "[long ").
 * Used to hide partial markers during streaming.
 */
const TRAILING_PARTIAL_PAUSE_RE =
  /\s*\[(?:long(?:\s+(?:p(?:a(?:u(?:s(?:e)?)?)?)?)?)?|p(?:a(?:u(?:s(?:e)?)?)?)?)?$/i;
/**
 * Trailing partial `[no-reply]` — matches any unfinished prefix
 * (e.g. "[n", "[no", "[no-", "[no-r", up through "[no-reply"). Used
 * during streaming so the user doesn't see "[no" briefly flash before
 * the rest of the marker arrives. Allows leading markdown wrappers.
 */
const TRAILING_PARTIAL_NO_REPLY_RE =
  /\s*[`*_]*\s*\[n(?:o(?:-(?:r(?:e(?:p(?:l(?:y)?)?)?)?)?)?)?$/i;

/**
 * Final-form strip (no streaming flicker handling). Suitable for fully
 * arrived messages.
 */
export function stripVoiceMarkers(text: string): string {
  if (!text) return text;
  // Orb mood marker — invisible to the user (it only animates the orb).
  let out = text.replace(MOOD_MARKER_RE, '');
  out = out.replace(DELIVER_CUE_RE, '');
  // Engine `[no-reply]` sentinel: never user-facing under any
  // circumstance. Drop completely (no inserted space — the agent
  // typically writes it on its own line or at end-of-message).
  out = out.replace(NO_REPLY_MARKER_RE, '');
  // Replace each inline pause marker with a single space so words on
  // either side don't fuse together; collapse runs afterwards.
  out = out.replace(PAUSE_MARKER_RE, ' ');
  out = out.replace(/ {2,}/g, ' ');
  // Strip trailing space before newlines and double newlines from the
  // cue removal.
  out = out.replace(/[ \t]+\n/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Streaming-safe strip. Same as stripVoiceMarkers plus:
 *   - if the text starts with "((" but the closing "))" hasn't arrived
 *     yet, hide everything (we're mid-cue);
 *   - if the text ends with a partial pause marker (e.g. "[pa"), trim
 *     that fragment so it doesn't flicker into view.
 */
export function stripVoiceMarkersForStream(text: string): string {
  if (!text) return text;
  // Mid-cue: the agent has started "((" but hasn't closed it yet — hide
  // the entire bubble body until the cue completes. The bubble will
  // start drawing once "))" arrives.
  if (/^\s*\(\(/.test(text) && !/\)\)/.test(text)) return '';
  let out = stripVoiceMarkers(text);
  // Trim a trailing partial pause-bracket so the user doesn't see
  // half-typed markers mid-stream.
  out = out.replace(TRAILING_PARTIAL_PAUSE_RE, '');
  // Same for a trailing partial [no-reply] sentinel — hide every
  // prefix from "[n" through "[no-reply" until the closing "]"
  // arrives and the full-form strip above catches it. Without this,
  // the user briefly sees "[no" before the rest streams in.
  out = out.replace(TRAILING_PARTIAL_NO_REPLY_RE, '');
  return out.trimEnd();
}
