// v3.5 text wave (t258, K34) — the Dreamer's soul states, once, what a ROUGH TASKS batch asks for: one
// lesson per task with lesson_record, or NO_ENTRY, and never a vault entry or a bug report.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const soul = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'templates', 'DREAMER-SOUL.md'), 'utf8');

describe('the Dreamer soul', () => {
  it('has the rough-tasks section after the cycle rules', () => {
    const at = soul.indexOf('# Lessons from rough tasks');
    expect(at).toBeGreaterThan(soul.indexOf('# How a cycle works'));
    expect(soul.slice(at)).toContain('either record ONE lesson with lesson_record');
    expect(soul.slice(at)).toContain('never save one with vault_remember and never put a bug in the vault. Then call complete_task.');
  });
});
