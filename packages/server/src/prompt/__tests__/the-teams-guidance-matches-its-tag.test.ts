// v3.5 text wave (t260 fix round 4) — the Teams guidance quotes the tag the notice really carries: the
// sender's email only; the display name sits inside the fence on its From line (tools/inbound-fences.ts).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const assembler = fs.readFileSync(path.join(here, '..', 'assembler.ts'), 'utf8');
const fences = fs.readFileSync(path.join(here, '..', '..', 'tools', 'inbound-fences.ts'), 'utf8');

describe('the Teams inbound guidance', () => {
  it('quotes the tag the notice builds', () => {
    expect(fences).toContain('`[SOURCE: TEAMS MESSAGE FROM ${m.senderEmail ?? \'a Teams contact\'}]`');
    expect(assembler).toContain('tagged \\`[SOURCE: TEAMS MESSAGE FROM {email}]\\` (the sender\'s name is inside the fence below it, on its From line)');
    expect(assembler).not.toContain('TEAMS MESSAGE FROM {name} ({email})');
  });
});
