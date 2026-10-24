// v3.5 fix round 1 (I-d-1) — "LOCAL" IS A PARSED HOSTNAME, NEVER A SUBSTRING. The decision seam's
// egress claim ("nothing it sends leaves this machine") and the RAM the calculator reads both rest on
// this answer, so a URL that merely CONTAINS "localhost" must not pass.
import { describe, it, expect } from 'vitest';
import { isLocalOllamaBaseUrl } from '../num-ctx-calculator.js';

describe('isLocalOllamaBaseUrl', () => {
  it.each([
    'http://localhost:11434', 'http://LOCALHOST:11434/', 'http://127.0.0.1:11434', 'http://127.4.5.6:11434',
    'http://[::1]:11434', 'localhost:11434',
  ])('%s is this machine', (url) => { expect(isLocalOllamaBaseUrl(url)).toBe(true); });

  it.each([
    'http://localhost@gpu-box:11434', 'http://localhost.example.net:11434', 'http://127.0.0.1.nip.io:11434',
    'http://gpu-box:11434/?localhost', 'http://192.168.1.20:11434', 'http://0.0.0.0:11434', 'not a url at all',
  ])('%s is NOT this machine', (url) => { expect(isLocalOllamaBaseUrl(url)).toBe(false); });

  it('no base URL means the default, which is this machine', () => {
    expect(isLocalOllamaBaseUrl(null)).toBe(true);
    expect(isLocalOllamaBaseUrl(undefined)).toBe(true);
  });
});
