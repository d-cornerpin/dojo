// v3.5 text wave — the PM's soul judges the measured record first (done-is-measured Part C6): a closed
// task is not the goal, a finished job is, and "bias toward validate" is gone.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const soul = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'templates', 'PM-SOUL.md'), 'utf8');

describe('the PM soul', () => {
  it('says the job is finished work, and judges the measured record first', () => {
    expect(soul).toContain('Your job is to make sure the work gets done. A closed task is not the goal; a finished job is.');
    expect(soul).toContain('**Judge the measured record first.**');
    expect(soul).toContain('**A task without a measure is judged on its ledger and receipts**');
    expect(soul).toContain('**Never validate on prose alone, but VERIFY before rejecting.**');
  });
  it('no longer biases toward validate or calls the job "tasks get completed"', () => {
    expect(soul).not.toContain('Bias toward validate');
    expect(soul).not.toContain('Bias toward `validate`');
    expect(soul).not.toContain('make sure tasks get completed');
  });
});
