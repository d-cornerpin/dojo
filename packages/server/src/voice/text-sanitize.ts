// Turns agent text into speakable text: strips markdown, collapses URLs to "link" and absolute paths to
// their basename, replaces fenced code with "code block", then runs normalizeForSpeech. Run it only on text
// buffered to a safe split point (see StreamingSpeechBuffer): partial markdown such as "**hel" would leak
// literal asterisks.

import { stripMoodMarker } from '@dojo/shared';
import { normalizeForSpeech } from './text-normalize.js';

const URL_RE = /\bhttps?:\/\/\S+/g;
const ABSOLUTE_PATH_RE = /(?:^|(?<=\s|\(|\[|"|'))~?\/[\w./\-_+@%]+/g;

export function sanitizeForSpeech(text: string): string {
  let s = text;

  // The orb mood marker only animates the orb and is never spoken (its regex lives in @dojo/shared).
  s = stripMoodMarker(s);

  // Fenced code reads badly aloud, so it is replaced by the words "code block".
  s = s.replace(/```[\s\S]*?```/g, ' code block ');

  s = s.replace(/`([^`\n]+)`/g, '$1');

  s = s.replace(/!\[([^\]]*)\]\([^)\s]+\)/g, (_, alt) => alt || 'image');

  s = s.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1');

  s = s.replace(URL_RE, (m) => {
    const trailing = m.match(/[).,;!?]+$/)?.[0] ?? '';
    return 'link' + trailing;
  });

  // Absolute and ~/ paths become the basename ("file" without an extension); relative paths like
  // src/foo are left alone because they read naturally in context.
  s = s.replace(ABSOLUTE_PATH_RE, (m) => {
    const trailing = m.match(/[).,;!?]+$/)?.[0] ?? '';
    const clean = trailing ? m.slice(0, -trailing.length) : m;
    const parts = clean.split('/').filter(Boolean);
    const tail = parts[parts.length - 1] ?? '';
    if (!/\.[a-zA-Z0-9]{1,8}$/.test(tail)) return 'file' + trailing;
    return tail + trailing;
  });

  s = s.replace(/^\s*#{1,6}\s+/gm, '');

  s = s.replace(/^\s*>\s+/gm, '');

  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1');

  s = s.replace(/^(\s*)\d+\.\s+/gm, '$1');

  // Emphasis: three markers before two before one.
  s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  s = s.replace(/(?<!\w)__([^_\n]+?)__(?!\w)/g, '$1');
  s = s.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1');
  s = s.replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1');

  s = s.replace(/~~([^~\n]+?)~~/g, '$1');

  // Collapse spaces and tabs but keep newlines.
  s = s.replace(/[ \t]+/g, ' ');

  s = s.replace(/[ \t]+$/gm, '');

  s = normalizeForSpeech(s);

  return s;
}

/** Default minimum fragment length (chars) for clause-level flushing. */
export const DEFAULT_CLAUSE_MIN_LEN = 30;

const CONJUNCTIONS = ['and', 'but', 'so', 'or', 'because'];

// Streaming-safe wrapper around sanitizeForSpeech: holds chunks and releases text only up to a point where
// every markdown marker is balanced, so a partial `**bo` is never sanitized. flushUnsafe() commits the rest.
export class StreamingSpeechBuffer {
  private buffer = '';

  push(chunk: string): string {
    const ready = this.pushRaw(chunk);
    return ready ? sanitizeForSpeech(ready) : '';
  }

  /** As push, but the released text is returned uncleaned, for a caller that cleans at its own door. */
  pushRaw(chunk: string): string {
    if (chunk) this.buffer += chunk;
    return this.takeSafe();
  }

  // Returns zero or more ready clauses, each at least `minLen` chars and ending at a sentence boundary, comma
  // or pre-conjunction break. The rest (and any unbalanced markdown) stays buffered for a later push.
  pushClauses(chunk: string, minLen: number = DEFAULT_CLAUSE_MIN_LEN): string[] {
    if (chunk) this.buffer += chunk;
    return this.takeClauses(minLen);
  }

  /** Take the raw text still held (a word, URL or marker split across chunks). */
  takeRaw(): string { const text = this.buffer; this.buffer = ''; return text; }

  /** Flush everything regardless of unbalanced markdown. */
  flushUnsafe(): string {
    const text = this.buffer;
    this.buffer = '';
    if (!text) return '';
    const out = sanitizeForSpeech(text);
    return out;
  }

  private takeClauses(minLen: number): string[] {
    const out: string[] = [];
    let consumed = 0;
    while (true) {
      const boundary = this.findClauseBoundary(consumed, minLen);
      if (boundary < 0) break;
      const raw = this.buffer.slice(consumed, boundary);
      consumed = boundary;
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      const sanitized = sanitizeForSpeech(trimmed);
      if (sanitized.trim().length > 0) out.push(sanitized.trim());
    }
    if (consumed > 0) this.buffer = this.buffer.slice(consumed);
    return out;
  }

  // End-exclusive index of the next clause boundary at or after `start` (clause at least `minLen` chars and
  // markdown balanced through it), or -1. Boundaries: sentence end, comma + whitespace, or whitespace
  // before a conjunction (so the next clause starts with it).
  private findClauseBoundary(start: number, minLen: number): number {
    const buf = this.buffer;
    const counts = { star2: 0, under2: 0, star1: 0, under1: 0, tick: 0, tick3: 0 };
    for (let i = start; i < buf.length; i++) {
      const c = buf[i];
      if (c === '`' && buf[i + 1] === '`' && buf[i + 2] === '`') {
        counts.tick3 ^= 1;
        i += 2;
        continue;
      }
      if (c === '`') { counts.tick ^= 1; continue; }
      if (c === '*' && buf[i + 1] === '*') { counts.star2 ^= 1; i++; continue; }
      if (c === '*') { counts.star1 ^= 1; continue; }
      if (c === '_' && buf[i + 1] === '_') { counts.under2 ^= 1; i++; continue; }
      if (c === '_' && (i === 0 || !/\w/.test(buf[i - 1])) && (i + 1 < buf.length && !/\s/.test(buf[i + 1]))) {
        counts.under1 ^= 1; continue;
      }
      const balanced = counts.star2 === 0 && counts.under2 === 0 &&
                       counts.star1 === 0 && counts.under1 === 0 &&
                       counts.tick === 0 && counts.tick3 === 0;
      if (!balanced) continue;

      const lenSoFar = i + 1 - start;
      if (lenSoFar < minLen) continue;

      if (/[.!?\n]/.test(c)) {
        const next = buf[i + 1];
        if (next === undefined) {
          // At EOF more text may still arrive; defer to the next push or flushUnsafe.
          continue;
        }
        if (/\s/.test(next)) return i + 1;
      }
      if (c === ',') {
        const next = buf[i + 1];
        if (next !== undefined && /\s/.test(next)) return i + 1;
      }
      if (/\s/.test(c)) {
        const rest = buf.slice(i + 1);
        const match = rest.match(/^([a-z]+)(?:\b|$)/i);
        if (match && CONJUNCTIONS.includes(match[1].toLowerCase())) {
          // The conjunction must end at whitespace or EOF, so "android" is not matched as "and".
          const after = rest[match[1].length];
          if (after === undefined || /\s/.test(after)) {
            return i + 1;
          }
        }
      }
    }
    return -1;
  }

  private takeSafe(): string {
    // Find the latest sentence end followed by whitespace with all markdown balanced through it;
    // flush nothing if there is none.
    let lastSafe = -1;
    const counts = { star2: 0, under2: 0, star1: 0, under1: 0, tick: 0, tick3: 0 };
    const buf = this.buffer;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c === '`' && buf[i + 1] === '`' && buf[i + 2] === '`') {
        counts.tick3 ^= 1;
        i += 2;
        continue;
      }
      if (c === '`') { counts.tick ^= 1; continue; }
      if (c === '*' && buf[i + 1] === '*') { counts.star2 ^= 1; i++; continue; }
      if (c === '*') { counts.star1 ^= 1; continue; }
      if (c === '_' && buf[i + 1] === '_') { counts.under2 ^= 1; i++; continue; }
      // A single _ counts as italic only at a word boundary (snake_case is safe).
      if (c === '_' && (i === 0 || !/\w/.test(buf[i - 1])) && (i + 1 < buf.length && !/\s/.test(buf[i + 1]))) {
        counts.under1 ^= 1; continue;
      }
      const balanced = counts.star2 === 0 && counts.under2 === 0 &&
                       counts.star1 === 0 && counts.under1 === 0 &&
                       counts.tick === 0 && counts.tick3 === 0;
      if (!balanced) continue;
      // A mark at the end of the buffer may be "3." of "3.5": it waits for the next chunk or the flush.
      if (/[.!?\n]/.test(c) && /\s/.test(buf[i + 1] ?? '')) lastSafe = i + 1;
    }
    if (lastSafe <= 0) return '';
    const ready = this.buffer.slice(0, lastSafe);
    this.buffer = this.buffer.slice(lastSafe);
    return ready;
  }
}
