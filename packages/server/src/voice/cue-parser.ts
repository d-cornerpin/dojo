// Delivery cue: a reply may start with `((deliver: gentle, slower))`, which becomes the cloud engine's
// synthesis description for that turn. It is stripped for both engines so it is never read aloud;
// one cue per turn, anchored at the start after leading whitespace.

import { stripMoodMarker } from '@dojo/shared';
import { stripLeadingTimeStamp } from '../memory/message-stamp.js';

const CUE_RE = /^\s*\(\(\s*deliver\s*:\s*([^)]*?)\s*\)\)\s*/i;

export interface ParsedCue {
  description: string | null;
  body: string;
}

// Parse a leading cue off `text` (an echoed time stamp before or after it goes too); text without a cue comes back unchanged.
export function parseDeliveryCue(raw: string): ParsedCue {
  const text = stripLeadingTimeStamp(raw);
  const m = CUE_RE.exec(text);
  if (!m) return { description: null, body: text };
  const description = m[1].trim();
  const body = stripLeadingTimeStamp(text.slice(m[0].length));
  return {
    description: description.length > 0 ? description : null,
    body,
  };
}

// Stateful extractor for one TTS burst: the cue may arrive split across chunks, so text is held until
// it completes or is clearly not a cue. The description is emitted once, on resolution.
export interface CueExtractor {
  consume(content: string): { content: string; description: string | null };
  // Release text still held at stream end (an unclosed cue was not a cue). Call before the sanitizer
  // flush so the released body rides the same bubble out to TTS.
  flush(): { content: string; description: string | null };
  // The raw text still held while a cue is incomplete.
  held(): string;
}

export function createCueExtractor(): CueExtractor {
  let resolved = false;
  let buffer = '';
  return {
    consume(content: string): { content: string; description: string | null } {
      if (resolved) return { content, description: null };
      buffer += content;
      const parsed = parseDeliveryCue(buffer);
      // Blank, a cue or a mood marker (whole or partial) so far: an echoed time stamp may still follow, so keep holding.
      if (couldBeIncompleteCue(parsed.body) || stripMoodMarker(parsed.body) === '') return { content: '', description: null };
      resolved = true;
      buffer = '';
      return { content: parsed.body, description: parsed.description };
    },
    flush(): { content: string; description: string | null } {
      if (resolved || buffer.length === 0) return { content: '', description: null };
      resolved = true;
      const parsed = parseDeliveryCue(buffer);
      buffer = '';
      return { content: parsed.body, description: parsed.description };
    },
    held: () => buffer,
  };
}

// True when `text` might be a partial cue, or a partial mood marker, still streaming in.
export function couldBeIncompleteCue(text: string): boolean {
  const trimmed = text.replace(/^\s+/, '');
  if (trimmed.length === 0) return false;
  if (trimmed[0] !== '(') return false;
  if (CUE_RE.test(trimmed)) return false;
  return /^\(\(?\s*(d(e(l(i(v(e(r(\s*(:.*)?)?)?)?)?)?)?)?)?$/i.test(trimmed)
    || /^\(\(\s*deliver\s*:[^)]*$/i.test(trimmed)
    || /^\(\(\s*m(o(o(d(\s*(:[^)]*\)?)?)?)?)?)?$/i.test(trimmed);
}
