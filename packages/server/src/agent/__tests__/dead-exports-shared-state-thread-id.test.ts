// DEAD-EXPORT CONTRACT — two exports that lost every production caller are
// gone, and the live exports sharing their files are untouched. The sources
// are read as text: this holds what the modules export, not their behavior.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedStateSrc = fs.readFileSync(path.join(AGENT, 'shared-state.ts'), 'utf8');
const transportSrc = fs.readFileSync(path.join(AGENT, 'a2a-transport.ts'), 'utf8');

describe('dead exports gone, live exports intact', () => {
  it('shared-state.ts no longer carries the legacy recovery ceiling', () => {
    expect(sharedStateSrc).not.toContain('MAX_CONSECUTIVE_INLOOP_RECOVERIES');
  });

  it('shared-state.ts keeps the live same-inputs ceiling', () => {
    expect(sharedStateSrc).toContain('export const MAX_INLOOP_RECOVERIES_SAME_INPUTS = 2');
  });

  it('a2a-transport.ts no longer defines makeThreadId', () => {
    expect(transportSrc).not.toContain('function makeThreadId');
  });

  it('a2a-transport.ts keeps the live delivery entry point', () => {
    expect(transportSrc).toContain('export async function deliverA2AMessage');
  });
});
