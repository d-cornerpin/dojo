/**
 * Convert agent text into something a TTS engine should pronounce naturally.
 *
 * - Strips markdown syntax (bold, italic, code, headers, lists, blockquotes, hr).
 * - Collapses URLs to the word "link" so Kokoro doesn't spell them letter-by-letter.
 * - Collapses absolute / `~/`-relative file paths to the bare basename
 *   (or "file" for paths without an extension) for the same reason.
 * - Removes triple-backtick code blocks entirely (they're never useful spoken).
 * - Finally runs `normalizeForSpeech` to expand units, abbreviations, TLDs, etc.
 *
 * Run this AFTER a streaming chunk has been buffered to a safe split point —
 * partial markdown (e.g. "**hel") will leak literal asterisks if sanitized
 * mid-token. See `StreamingSpeechBuffer` for that buffering.
 */

import { normalizeForSpeech } from './text-normalize.js';

const URL_RE = /\bhttps?:\/\/\S+/g;
const ABSOLUTE_PATH_RE = /(?:^|(?<=\s|\(|\[|"|'))~?\/[\w./\-_+@%]+/g;

export function sanitizeForSpeech(text: string): string {
  let s = text;

  // 0. Drop the orb mood marker (`((mood: NAME))`) so it is never spoken — it
  //    only animates the on-screen orb and is invisible to the user.
  s = s.replace(/\(\(\s*mood\s*:\s*[a-z]+\s*\)\)/gi, '');

  // 1. Drop fenced code blocks entirely (the primary agent uses them for tool examples /
  //    config snippets; spoken word doesn't benefit from "import os newline
  //    def main colon").
  s = s.replace(/```[\s\S]*?```/g, ' code block ');

  // 2. Inline code: `foo` → foo (drop backticks).
  s = s.replace(/`([^`\n]+)`/g, '$1');

  // 3. Images: ![alt](url) → "alt" (or "image" if no alt).
  s = s.replace(/!\[([^\]]*)\]\([^)\s]+\)/g, (_, alt) => alt || 'image');

  // 4. Links: [text](url) → just the link text.
  s = s.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1');

  // 5. Bare URLs → "link" (keeps trailing punctuation outside).
  s = s.replace(URL_RE, (m) => {
    const trailing = m.match(/[).,;!?]+$/)?.[0] ?? '';
    return 'link' + trailing;
  });

  // 6. Absolute / home-relative paths → basename (or "file").
  //    Catches `/foo/bar.txt`, `~/dev-smarter.md`, `/Users/<name>/...`.
  //    Intentionally does NOT catch relative paths like `src/foo` — those
  //    are usually spoken naturally in context.
  s = s.replace(ABSOLUTE_PATH_RE, (m) => {
    const trailing = m.match(/[).,;!?]+$/)?.[0] ?? '';
    const clean = trailing ? m.slice(0, -trailing.length) : m;
    const parts = clean.split('/').filter(Boolean);
    const tail = parts[parts.length - 1] ?? '';
    // No extension? Just say "file".
    if (!/\.[a-zA-Z0-9]{1,8}$/.test(tail)) return 'file' + trailing;
    return tail + trailing;
  });

  // 7. Headers: ## Heading → Heading.
  s = s.replace(/^\s*#{1,6}\s+/gm, '');

  // 8. Blockquotes: > foo → foo.
  s = s.replace(/^\s*>\s+/gm, '');

  // 9. Horizontal rules.
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // 10. Bullets: `- foo`, `* foo`, `+ foo` at line start.
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1');

  // 11. Numbered lists: `1. foo` → `foo`.
  s = s.replace(/^(\s*)\d+\.\s+/gm, '$1');

  // 12. Emphasis. Order matters — three before two before one.
  s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  s = s.replace(/(?<!\w)__([^_\n]+?)__(?!\w)/g, '$1');
  s = s.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1');
  s = s.replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1');

  // 13. Strikethrough.
  s = s.replace(/~~([^~\n]+?)~~/g, '$1');

  // 14. Collapse multiple spaces / tabs (not newlines — Kokoro uses them).
  s = s.replace(/[ \t]+/g, ' ');

  // 15. Trim trailing whitespace per line.
  s = s.replace(/[ \t]+$/gm, '');

  // 16. Expand units / abbreviations / TLDs into pronounceable forms.
  //     ("72°F" → "72 degrees Fahrenheit", "example.com" → "example dot com", etc.)
  s = normalizeForSpeech(s);

  return s;
}

/**
 * Streaming-safe wrapper around `sanitizeForSpeech`.
 *
 * Holds a buffer of incoming text chunks. Only flushes text up to the last
 * "safe" point — a position past any unclosed markdown marker. This prevents
 * a partial `**bo` from being sanitized while `**bold**` is still streaming.
 *
 *   const buf = new StreamingSpeechBuffer();
 *   buf.push('Hey **bold');   // → ''   (** is unbalanced, hold)
 *   buf.push(' text**!');     // → 'Hey bold text!'  (now balanced)
 *   buf.flush();              // → ''   (nothing left)
 *
 * On bubble-end (or any point you want to commit partial markdown anyway),
 * call `flushUnsafe()` — it sanitizes whatever is left, leaking literal
 * asterisks if necessary.
 */
/** Default minimum fragment length (chars) for clause-level flushing. */
export const DEFAULT_CLAUSE_MIN_LEN = 30;

const CONJUNCTIONS = ['and', 'but', 'so', 'or', 'because'];

export class StreamingSpeechBuffer {
  private buffer = '';

  push(chunk: string): string {
    if (!chunk) return '';
    this.buffer += chunk;
    return this.takeSafe();
  }

  /**
   * Clause-level streaming flush (Phase 4). Each push returns zero or more
   * ready clauses — each one is at least `minLen` characters and ends at a
   * sentence boundary, comma, or pre-conjunction word break. Anything past
   * the last clause boundary (and anything inside unbalanced markdown) stays
   * buffered until a later push completes it. Designed for callers that
   * synthesize one clause at a time so audio starts within the first phrase
   * of an LLM reply rather than after the first full sentence.
   */
  pushClauses(chunk: string, minLen: number = DEFAULT_CLAUSE_MIN_LEN): string[] {
    if (chunk) this.buffer += chunk;
    return this.takeClauses(minLen);
  }

  /** Flush everything regardless of unbalanced markdown. */
  flushUnsafe(): string {
    const text = this.buffer;
    this.buffer = '';
    if (!text) return '';
    const out = sanitizeForSpeech(text);
    return out;
  }

  hasPending(): boolean {
    return this.buffer.length > 0;
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

  /**
   * Find the next clause boundary at or after `start`, requiring the
   * resulting clause to be at least `minLen` characters AND markdown to
   * be balanced through that point. Returns the end-exclusive index
   * (one past the boundary character) or -1 if no boundary is ready.
   *
   * Recognised boundaries:
   *   - sentence-end punctuation (.!?) or newline followed by whitespace/EOF
   *   - comma followed by whitespace
   *   - whitespace immediately preceding a conjunction word
   *     (and / but / so / or / because)
   */
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

      // Length check is on the prospective clause (start..i+1).
      const lenSoFar = i + 1 - start;
      if (lenSoFar < minLen) continue;

      // Sentence-end punctuation followed by whitespace/EOF.
      if (/[.!?\n]/.test(c)) {
        const next = buf[i + 1];
        if (next === undefined) {
          // EOF — defer: more content may still arrive; we'll catch this on
          // the next push, or via flushUnsafe at bubble done.
          continue;
        }
        if (/\s/.test(next)) return i + 1;
      }
      // Comma followed by whitespace.
      if (c === ',') {
        const next = buf[i + 1];
        if (next !== undefined && /\s/.test(next)) return i + 1;
      }
      // Whitespace followed by a conjunction word — boundary is BEFORE the
      // conjunction so the next clause begins with it (matches natural
      // prosody, e.g. "I went to the store" / "and bought some milk").
      if (/\s/.test(c)) {
        const rest = buf.slice(i + 1);
        const match = rest.match(/^([a-z]+)(?:\b|$)/i);
        if (match && CONJUNCTIONS.includes(match[1].toLowerCase())) {
          // Need a trailing space after the conjunction to know it's a word,
          // not a prefix in the middle of another (e.g. "android" starts with
          // "and"). If conjunction word would terminate or hit whitespace, fine.
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
    // Walk backward to find the latest safe split point: ideally end-of-sentence
    // followed by whitespace, with all markdown counters balanced through that
    // point. Falls back to no flush if nothing safe.
    let lastSafe = -1;
    const counts = { star2: 0, under2: 0, star1: 0, under1: 0, tick: 0, tick3: 0 };
    const buf = this.buffer;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      // Triple-backtick toggle
      if (c === '`' && buf[i + 1] === '`' && buf[i + 2] === '`') {
        counts.tick3 ^= 1;
        i += 2;
        continue;
      }
      if (c === '`') { counts.tick ^= 1; continue; }
      if (c === '*' && buf[i + 1] === '*') { counts.star2 ^= 1; i++; continue; }
      if (c === '*') { counts.star1 ^= 1; continue; }
      if (c === '_' && buf[i + 1] === '_') { counts.under2 ^= 1; i++; continue; }
      // Single _: only counts as italic when at word boundary (avoids snake_case)
      if (c === '_' && (i === 0 || !/\w/.test(buf[i - 1])) && (i + 1 < buf.length && !/\s/.test(buf[i + 1]))) {
        counts.under1 ^= 1; continue;
      }
      const balanced = counts.star2 === 0 && counts.under2 === 0 &&
                       counts.star1 === 0 && counts.under1 === 0 &&
                       counts.tick === 0 && counts.tick3 === 0;
      if (!balanced) continue;
      // Sentence boundary: . ! ? newline followed by space/newline/end
      if (/[.!?\n]/.test(c)) {
        const next = buf[i + 1];
        if (next === undefined || /\s/.test(next)) {
          lastSafe = i + 1;
        }
      }
    }
    if (lastSafe <= 0) return '';
    const ready = this.buffer.slice(0, lastSafe);
    this.buffer = this.buffer.slice(lastSafe);
    return sanitizeForSpeech(ready);
  }
}
