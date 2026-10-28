// ════════════════════════════════════════════════════════════════════════════════════
// services/openai-compatible-url.ts — ONE builder for an OpenAI-compatible provider URL.
//
// The three media services each built the provider URL by hand and none of them knew
// a base URL may already end in `/v1` — the shape a local server prints, and what the
// chat path (`resolveOpenAIBaseUrl`, agent/model.ts) already handles. So
// `http://localhost:8000/v1` got `…/v1/v1/chat/completions` for image and speech
// (and `…/v1/v1/audio/transcriptions` for transcription) and a 404, while chat on the
// same provider worked. The preset shapes must not move: OpenRouter's
// `https://openrouter.ai/api` still yields `…/api/v1/…`.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { openAiCompatibleUrl } from '../openai-compatible-url.js';

describe('openAiCompatibleUrl — a base URL that already ends in /v1 is not doubled', () => {
  it.each([
    // no usable base at all → the OpenAI default
    [null, 'chat/completions', 'https://api.openai.com/v1/chat/completions'],
    [undefined, 'audio/transcriptions', 'https://api.openai.com/v1/audio/transcriptions'],
    ['', 'chat/completions', 'https://api.openai.com/v1/chat/completions'],
    // the presets, byte-identical to what the hand-builds produced
    ['https://openrouter.ai/api', 'chat/completions', 'https://openrouter.ai/api/v1/chat/completions'],
    ['https://openrouter.ai/api/v1/', 'audio/transcriptions', 'https://openrouter.ai/api/v1/audio/transcriptions'],
    // a base that already ends in /v1 must not get a second one
    ['http://localhost:8000/v1', 'chat/completions', 'http://localhost:8000/v1/chat/completions'],
    ['https://api.groq.com/openai/v1', 'audio/transcriptions', 'https://api.groq.com/openai/v1/audio/transcriptions'],
    // bare host → +/v1; the /v1 test is case-insensitive, the URL keeps its case
    ['http://localhost:1234', 'audio/transcriptions', 'http://localhost:1234/v1/audio/transcriptions'],
    ['https://api.openai.com/V1', 'chat/completions', 'https://api.openai.com/V1/chat/completions'],
  ] as Array<[string | null | undefined, string, string]>)('%s + %s', (base, path, want) => {
    expect(openAiCompatibleUrl(base, path)).toBe(want);
  });
});

describe('the three media services stop hand-building the provider URL', () => {
  // Header prose names the endpoint each service calls; what must be gone is the
  // code that builds it by hand.
  const codeOnly = (src: string): string =>
    src.split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');

  for (const file of ['audio-generation.ts', 'image-generation.ts', 'transcription.ts']) {
    it(`${file} goes through openAiCompatibleUrl`, () => {
      const code = codeOnly(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
      expect(code).toContain('openAiCompatibleUrl(');
      expect(code).not.toContain('/v1/chat/completions');
      expect(code).not.toContain('/v1/audio/transcriptions');
    });
  }
});
