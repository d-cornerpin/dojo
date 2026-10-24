// K37 — a tool error's FINGERPRINT is what lets two agents' identical failures count as one.
// The text differs only by ids, paths, numbers and addresses; those must not split the count.

import { describe, it, expect } from 'vitest';
import { fingerprint, canonicalToolName } from '../error-fingerprint.js';

describe('fingerprint(toolName, errorText)', () => {
  it('lowercases and collapses whitespace', () => {
    expect(fingerprint('gmail_label', 'Error   Modifying\n Labels:  Invalid LABEL')).toBe('error modifying labels: invalid label');
  });

  it('two otherwise identical errors that differ only by ids, uuids, paths, numbers and emails fingerprint the same', () => {
    const a = fingerprint('file_read', 'Cannot read /var/data/docs/report-2024.pdf (message 18f3a9c2d4e5b601, id 3f2b8c1e-9d4a-4c7e-8a11-0b5d6e7f8a90) after 3 tries; contact a.person@example.com');
    const b = fingerprint('file_read', 'Cannot read /opt/other/place/notes-77.pdf (message 99aa88bb77cc6601, id 0a1b2c3d-1111-2222-3333-444455556666) after 12 tries; contact someone.else@example.org');
    expect(a).toBe(b);
    expect(a).not.toMatch(/var\/data|opt\/other|example|\d{3}/);
  });

  it('different failures stay different', () => {
    expect(fingerprint('gmail_label', 'Invalid label: Junk E-mail')).not.toBe(fingerprint('gmail_label', 'Requested entity was not found.'));
  });

  it('keeps only the first 200 characters', () => {
    expect(fingerprint('x_tool', 'a'.repeat(500)).length).toBe(200);
  });

  it('the base and the user_ variant of a tool fingerprint the same, whichever name the text echoes', () => {
    expect(fingerprint('user_gmail_label', 'user_gmail_label failed: Invalid label: X'))
      .toBe(fingerprint('gmail_label', 'gmail_label failed: Invalid label: X'));
    expect(canonicalToolName('user_gmail_label')).toBe('gmail_label');
    expect(canonicalToolName('gmail_label')).toBe('gmail_label');
  });
});
