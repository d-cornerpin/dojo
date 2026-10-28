import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('the unused voice helpers stay gone', () => {
  it('tts-service.ts has no synthesizeStream, createTextSplitter or KOKORO_SAMPLE_RATE', () => {
    const text = read('voice/tts-service.ts');
    expect(/\bsynthesizeStream\b/.test(text)).toBe(false);
    expect(/\bcreateTextSplitter\b/.test(text)).toBe(false);
    expect(/\bKOKORO_SAMPLE_RATE\b/.test(text)).toBe(false);
  });
  it('stt-service.ts has no transcribeFileCli or WHISPER_CLI_BINARY', () => {
    const text = read('voice/stt-service.ts');
    expect(/\btranscribeFileCli\b/.test(text)).toBe(false);
    expect(/\bWHISPER_CLI_BINARY\b/.test(text)).toBe(false);
  });
  it('the live clause path is still exported', () => {
    const text = read('voice/tts-service.ts');
    expect(text).toContain('export async function* synthesizeClauseStream');
    expect(text).toContain('export function createClauseQueue');
  });
});
