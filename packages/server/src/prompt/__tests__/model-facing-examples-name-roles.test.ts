// v3.5 text wave (orchestrator ruling 3) — the examples the model reads name roles, never people.
// The sites found by the census of the server tree; each source must not carry the old name.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('model-facing examples name roles', () => {
  it.each([
    ['prompt/assembler.ts', /Nora/, 'Always send the research agent\'s posts via iMessage'],
    ['microsoft/tools-read.ts', /'Alex'/, 'E.g., a first name, \'acme.com\', \'CFO\'.'],
    ['services/imessage-bridge.ts', /\?\? 'Alex'/, 'senderRecord?.name ?? \'This contact\''],
    ['vault/tools.ts', /Bob's address/, 'the contractor\'s address is still unknown'],
  ])('%s', (rel, gone, now) => {
    const text = read(rel);
    expect(text).not.toMatch(gone);
    expect(text).toContain(now);
  });
});
