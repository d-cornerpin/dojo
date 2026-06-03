/**
 * Strip the cloud voice-mode delivery cue and inline pause markers from
 * displayed text. Used by every AssistantBubble when wordyMode is off
 * so the chat reads like normal prose, while wordy mode shows the raw
 * agent output with the markers visible.
 *
 * Markers handled:
 *   - Leading ((deliver: ...)) cue line (matches case-insensitively)
 *   - Inline [pause] and [long pause] markers
 *
 * The functions also handle in-flight streaming: if a cue or pause
 * marker is still arriving mid-stream, the partial fragment is hidden
 * rather than briefly flashed to the user.
 */

const DELIVER_CUE_RE = /^\s*\(\(\s*deliver\s*:\s*[^)]*?\s*\)\)\s*/i;
const PAUSE_MARKER_RE = /\s*\[(?:long\s+)?pause\]\s*/gi;

/**
 * Trailing partial pause-marker — matches a bracket that's started but
 * not yet closed (e.g. "[pa", "[long pause", "[long ").
 * Used to hide partial markers during streaming.
 */
const TRAILING_PARTIAL_PAUSE_RE =
  /\s*\[(?:long(?:\s+(?:p(?:a(?:u(?:s(?:e)?)?)?)?)?)?|p(?:a(?:u(?:s(?:e)?)?)?)?)?$/i;

/**
 * Final-form strip (no streaming flicker handling). Suitable for fully
 * arrived messages.
 */
export function stripVoiceMarkers(text: string): string {
  if (!text) return text;
  let out = text.replace(DELIVER_CUE_RE, '');
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
  return out.trimEnd();
}
