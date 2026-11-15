import { describe, it, expect } from 'vitest';
import { stripVoiceMarkers } from '../lib/voice-markers';

describe('the chat text with a control mark taken out', () => {
  it('keeps one space where a mark sat between two words, and none at an edge', () => {
    expect(stripVoiceMarkers('Hello [no-reply]world')).toBe('Hello world');
    expect(stripVoiceMarkers('word[no-reply]word')).toBe('word word');
    expect(stripVoiceMarkers('Done. [no-reply]')).toBe('Done.');
  });
});
