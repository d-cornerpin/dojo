/**
 * Per-turn delivery-cue parsing.
 *
 * Voice-mode replies on the cloud engine (Hume) can begin with a single
 * line in the form:
 *
 *   ((deliver: gentle, slower, reassuring))
 *
 * When present, the contents become the `description` ("acting
 * instructions") Hume applies to that turn's synthesis, overriding the
 * standing baseline. The cue itself is stripped from the spoken text so
 * it never reaches the TTS engine.
 *
 * The strip runs defensively for BOTH engines, Kokoro doesn't use the
 * description, but if the agent emits a stray cue (e.g. in a turn that
 * routes through the local engine), we don't want "open paren open paren
 * deliver colon" read aloud.
 *
 * Cue rules (per the v2.9 cloud-TTS brief):
 *   - One cue per turn, at the very start. No inline mid-utterance changes.
 *   - Match is anchored to the start of the buffered text after trimming
 *     leading whitespace.
 *   - We accept the cue across the streaming-token boundary, so the parser
 *     is called on the full accumulated burst-prefix rather than per chunk.
 */

const CUE_RE = /^\s*\(\(\s*deliver\s*:\s*([^)]*?)\s*\)\)\s*/i;

export interface ParsedCue {
  /** The delivery description from `((deliver: ...))` if present, else null. */
  description: string | null;
  /** The remaining text with the cue stripped from the front. */
  body: string;
}

/**
 * Parse a leading `((deliver: ...))` cue off the front of `text`. Whitespace
 * around the cue is consumed. Returns the description (or null) and the
 * remaining body. Idempotent on bodies that don't start with a cue.
 */
export function parseDeliveryCue(text: string): ParsedCue {
  const m = CUE_RE.exec(text);
  if (!m) return { description: null, body: text };
  const description = m[1].trim();
  const body = text.slice(m[0].length);
  return {
    description: description.length > 0 ? description : null,
    body,
  };
}

/**
 * Returns true when `text` MIGHT be a partial cue still streaming in.
 * Used by voice-ws.ts to hold back text from the TTS pipeline until the
 * cue is either complete (parseDeliveryCue returns description != null
 * with non-empty body) or definitively not a cue. Without this, a chunk
 * like "((deliv" would land in the TTS buffer before "er: warm))" arrives.
 */
/**
 * Stateful cue extractor for a single TTS burst. Streaming-token-safe ,
 * the agent's cue can arrive across multiple chat:chunk events
 * ("((deli" then "ver: warm))"), so the extractor buffers until the cue
 * is either complete (a closing `))`) or definitively not a cue.
 *
 * Once resolved, subsequent calls pass the content through unchanged
 * with description=null. The description is emitted only once, on the
 * chunk that resolves the cue.
 *
 * Usage:
 *   const cue = createCueExtractor();
 *   // for each chat:chunk content:
 *   const { content, description } = cue.consume(chunkContent);
 *   if (description) hume.setDescription(description);
 *   if (content.length > 0) pushToTts(content);
 */
export interface CueExtractor {
  consume(content: string): { content: string; description: string | null };
  /**
   * Release anything still held in the buffer at stream end. If the extractor
   * is mid-buffer on what looked like a cue but the closing `))` never
   * arrived, the held text was NOT a cue after all, so we hand it back
   * verbatim rather than swallow it. Returns empty content when nothing is
   * buffered (cue already resolved, or no text seen). Call this at bubble-done
   * BEFORE the sanitizer flush so the released body still rides this bubble's
   * tail out to TTS.
   */
  flush(): { content: string; description: string | null };
}

export function createCueExtractor(): CueExtractor {
  let resolved = false;
  let buffer = '';
  return {
    consume(content: string): { content: string; description: string | null } {
      if (resolved) return { content, description: null };
      buffer += content;
      if (couldBeIncompleteCue(buffer)) {
        // Hold, more text needed to know whether this is a cue or just
        // a parenthetical that happens to start with '('.
        return { content: '', description: null };
      }
      resolved = true;
      const parsed = parseDeliveryCue(buffer);
      buffer = '';
      return { content: parsed.body, description: parsed.description };
    },
    flush(): { content: string; description: string | null } {
      if (resolved || buffer.length === 0) return { content: '', description: null };
      resolved = true;
      // A complete cue would already have resolved inside consume(), so a
      // buffer that survives to flush is an UNCLOSED cue. parseDeliveryCue is
      // a no-op on it (CUE_RE needs the trailing `))`), returning the whole
      // buffer as the body, exactly the text we must not drop.
      const parsed = parseDeliveryCue(buffer);
      buffer = '';
      return { content: parsed.body, description: parsed.description };
    },
  };
}

export function couldBeIncompleteCue(text: string): boolean {
  const trimmed = text.replace(/^\s+/, '');
  if (trimmed.length === 0) return false;
  // Fast reject: anything not starting with '(' can't be a cue.
  if (trimmed[0] !== '(') return false;
  // If we have a complete cue, it's not "incomplete".
  if (CUE_RE.test(trimmed)) return false;
  // Still streaming "((deliver: ...", looks like a partial cue.
  return /^\(\(?\s*(d(e(l(i(v(e(r(\s*(:.*)?)?)?)?)?)?)?)?)?$/i.test(trimmed)
    || /^\(\(\s*deliver\s*:[^)]*$/i.test(trimmed);
}
