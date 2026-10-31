// The watchdog never texts the first entry of a list just because the owner left the star off on purpose.
import { describe, it, expect } from 'vitest';
import { chooseOwnerRecipient } from '../../../../../watchdog/src/owner-recipient.js';

const list = (...a: Array<[string, boolean?]>) => a.map(([address, is_primary]) => ({ address, is_primary }));

describe('chooseOwnerRecipient', () => {
  it('the starred entry is the owner', () => {
    expect(chooseOwnerRecipient(list(['+15550001'], ['+15550002', true]), null)).toBe('+15550002');
  });
  it('a list with no star has no owner: nobody is texted', () => {
    expect(chooseOwnerRecipient(list(['+15550001'], ['+15550002']), null)).toBe('');
  });
  it('the owner\'s own legacy default-sender designation still wins when it is an approved sender', () => {
    expect(chooseOwnerRecipient(list(['+15550001'], ['+15550002', true]), '(555) 0001'.replace(/.*/, '+15550001'))).toBe('+15550001');
  });
  it('a legacy key naming someone who is not approved is ignored', () => {
    expect(chooseOwnerRecipient(list(['+15550001', true]), '+19998887777')).toBe('+15550001');
    expect(chooseOwnerRecipient(list(['+15550001']), '+19998887777')).toBe('');
  });
  it('an empty list texts nobody', () => {
    expect(chooseOwnerRecipient([], '+15550001')).toBe('');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
describe('the watchdog daemon', () => {
  it('resolves its recipient through chooseOwnerRecipient and has no first-entry fallback', () => {
    const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../watchdog/src/index.ts'), 'utf-8');
    expect(src).toContain('chooseOwnerRecipient(');
    expect(src).not.toMatch(/approved\[0\]/);
  });
});
