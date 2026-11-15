// voice/cue-parser — pinning the streaming-safe delivery-cue strip.
//
// `((deliver: ...))` cues are stripped off the front of a spoken reply so TTS
// never reads "open paren open paren deliver colon" aloud. The cue can arrive
// split across streaming chunks, which is the easy place to get wrong, so the
// extractor's hold-then-resolve contract and the verbatim flush are pinned here.
// Measured against v35; these are pinning tests and pass unchanged.

import { describe, it, expect } from 'vitest';
import {
  parseDeliveryCue,
  couldBeIncompleteCue,
  createCueExtractor,
} from '../cue-parser.js';

describe('§1 parseDeliveryCue strips a leading cue', () => {
  it('a complete cue yields its description and the trailing body', () => {
    expect(parseDeliveryCue('((deliver: warm, slow)) Hello')).toEqual({
      description: 'warm, slow',
      body: 'Hello',
    });
  });

  it('leading whitespace before the cue is consumed, result unchanged', () => {
    expect(parseDeliveryCue('   ((deliver: warm, slow)) Hello')).toEqual({
      description: 'warm, slow',
      body: 'Hello',
    });
  });

  it('text without a cue is returned unchanged with a null description', () => {
    expect(parseDeliveryCue('Just talkin here, no cue.')).toEqual({
      description: null,
      body: 'Just talkin here, no cue.',
    });
  });

  it('an empty cue body collapses to a null description but keeps the body', () => {
    expect(parseDeliveryCue('((deliver: ))hi')).toEqual({
      description: null,
      body: 'hi',
    });
  });

  it('the match is case-insensitive', () => {
    expect(parseDeliveryCue('((DELIVER:calm))x')).toEqual({
      description: 'calm',
      body: 'x',
    });
  });

  it('a cue in the middle of the text is NOT stripped', () => {
    expect(parseDeliveryCue('hello ((deliver: warm)) world')).toEqual({
      description: null,
      body: 'hello ((deliver: warm)) world',
    });
  });
});

describe('§2 couldBeIncompleteCue decides hold-vs-release', () => {
  it('a streaming prefix that could still become a cue holds', () => {
    expect(couldBeIncompleteCue('((')).toBe(true);
    expect(couldBeIncompleteCue('((deli')).toBe(true);
    expect(couldBeIncompleteCue('((deliver: warm')).toBe(true);
  });

  it('non-cue and resolved text is released', () => {
    expect(couldBeIncompleteCue('hello')).toBe(false);
    expect(couldBeIncompleteCue('')).toBe(false);
    expect(couldBeIncompleteCue('   ')).toBe(false);
    // A complete cue is definitively NOT incomplete.
    expect(couldBeIncompleteCue('((deliver: w)) x')).toBe(false);
  });
});

describe('§3 the extractor resolves a cue split across chunks', () => {
  it('holds a partial cue, resolves it, then passes later text straight through', () => {
    const e = createCueExtractor();

    expect(e.consume('((deli')).toEqual({ content: '', description: null });
    expect(e.consume('ver: warm)) Hi')).toEqual({
      content: 'Hi',
      description: 'warm',
    });
    // Once resolved, text passes through untouched.
    expect(e.consume(' there')).toEqual({ content: ' there', description: null });
    expect(e.flush()).toEqual({ content: '', description: null });
  });
});

describe('§4 text that is not a cue passes straight through', () => {
  it('a plain chunk is emitted with a null description', () => {
    expect(createCueExtractor().consume('Hello')).toEqual({
      content: 'Hello',
      description: null,
    });
  });
});

describe('§5 an unfinished cue at stream end is handed back, not swallowed', () => {
  it('flush releases the held partial verbatim, and a second flush is empty', () => {
    const e = createCueExtractor();
    expect(e.consume('((deli')).toEqual({ content: '', description: null });
    expect(e.flush()).toEqual({ content: '((deli', description: null });
    expect(e.flush()).toEqual({ content: '', description: null });
  });
});

describe('§6 a cue split one character at a time resolves exactly once', () => {
  it('emits the description once, with the first spoken word', () => {
    const e = createCueExtractor();
    const text = '((deliver: gentle)) Okay';

    let content = '';
    const descriptions: string[] = [];
    for (const ch of text) {
      const r = e.consume(ch);
      content += r.content;
      if (r.description !== null) descriptions.push(r.description);
    }
    // The cue resolves with the first word after it; the flush contributes nothing once resolved.
    const end = e.flush();
    content += end.content;
    if (end.description !== null) descriptions.push(end.description);

    expect(descriptions).toEqual(['gentle']);
    expect(content).toBe('Okay');
  });
});

describe('§7 an echoed time stamp after a blank or cue-only start is never spoken', () => {
  it('a blank first chunk, then a stamp and a sentence', () => {
    const e = createCueExtractor();
    expect(e.consume('\n')).toEqual({ content: '', description: null });
    expect(e.consume('[Jul 16, 2026, 10:58 PM] Done.')).toEqual({ content: 'Done.', description: null });
  });

  it('a cue first, then a stamp and a sentence', () => {
    const e = createCueExtractor();
    expect(e.consume('((deliver: warm)) ')).toEqual({ content: '', description: null });
    expect(e.consume('[Jul 16, 2026, 10:58 PM] Done.')).toEqual({ content: 'Done.', description: 'warm' });
  });
});

describe('§8 an echoed time stamp behind a mood marker is never spoken', () => {
  const STAMP = '[Nov 15, 2026, 3:04 PM]';
  const spoken = (chunks: string[]): string => {
    const e = createCueExtractor();
    return chunks.map((c) => e.consume(c).content).join('') + e.flush().content;
  };

  it('the mood marker split across chunks, then the stamp, then the sentence', () => {
    expect(spoken(['((', 'mood: warm)) ', STAMP, ' Done.'])).toBe('((mood: warm)) Done.');
    expect(spoken([`((mood: warm)) ${STAMP} Done.`])).toBe('((mood: warm)) Done.');
  });

  it('the same after a delivery cue (the cloud voice)', () => {
    expect(spoken(['((deliver: warm)) ', '((', 'mood: warm)) ', STAMP, ' Done.'])).toBe('((mood: warm)) Done.');
    expect(spoken([`((deliver: warm)) ((mood: warm)) ${STAMP} Done.`])).toBe('((mood: warm)) Done.');
  });

  it('a reply with no mood marker is released at once', () => {
    expect(createCueExtractor().consume('Done.')).toEqual({ content: 'Done.', description: null });
  });
});
