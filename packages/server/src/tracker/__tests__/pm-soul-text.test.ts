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
    expect(soul).toContain('# Deciding hand-ins');
    expect(soul).toContain('A measured task is finished only when its measure reads 0');
    expect(soul).toContain('a message saying "done" is the worker\'s account, not the work');
  });
  it('no longer biases toward validate or calls the job "tasks get completed"', () => {
    expect(soul).not.toContain('Bias toward validate');
    expect(soul).not.toContain('Bias toward `validate`');
    expect(soul).not.toContain('make sure tasks get completed');
  });

  it('opens the proof, decides in one line or sends back, and never decides its own work or reassigns', () => {
    expect(soul).toContain('work_validate(action="open_proof", task_id, item=N)');
    expect(soul).toContain('verdict="approve", reason="<one line: how the proof meets the goal>"');
    expect(soul).toContain('You never decide your own work, and you never close, reassign or flip a worker\'s status.');
  });
});
