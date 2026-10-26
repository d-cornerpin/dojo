// K37 — the two halves of the fingerprint that carry their own meaning: maskVolatile is what the
// tool-error ledger STORES and prints as its sample (case kept, not cut to 200), and stripEngineNotes
// is where a stored result's own words end and the engine's appended notes begin.

import { describe, it, expect } from 'vitest';
import { maskVolatile, stripEngineNotes, fingerprint } from '../error-fingerprint.js';

describe('maskVolatile(toolName, errorText)', () => {
  it('masks a path and a count but keeps the case', () => {
    expect(maskVolatile('gmail_label', 'Cannot Read /var/data/a.pdf after 3 tries'))
      .toBe('Cannot Read <path> after <n> tries');
  });

  it('folds a user_ twin back to its base name wherever it echoes', () => {
    expect(maskVolatile('user_gmail_label', 'user_gmail_label failed: Invalid Label: X'))
      .toBe('gmail_label failed: Invalid Label: X');
  });

  it('masks an email and an id, collapsing whitespace and a newline to a single space', () => {
    expect(maskVolatile('t', 'Mail to Jo.Bo@Example.com  failed\n at 18f3a9c2d4e5b601'))
      .toBe('Mail to <email> failed at <id>');
  });

  it('masks a url but keeps the HTTP status, then trims', () => {
    expect(maskVolatile('t', '  HTTP 403 Forbidden for https://api.example.com/v1/x?y=1  '))
      .toBe('HTTP 403 Forbidden for <url>');
  });

  it('keeps the statuses "404" after Error and "(403)" in parentheses, masking the bare counts', () => {
    expect(maskVolatile('t', 'Error 404 on page 7 (retry 2) (403)'))
      .toBe('Error 404 on page <n> (retry <n>) (403)');
  });

  it('masks a uuid and a long run of letters as an id', () => {
    expect(maskVolatile('t', 'id 3f2b8c1e-9d4a-4c7e-8a11-0b5d6e7f8a90 gone')).toBe('id <id> gone');
    expect(maskVolatile('t', 'x'.repeat(30))).toBe('<id>');
  });

  it('treats undefined and null as the empty string', () => {
    expect(maskVolatile('t', undefined as never)).toBe('');
    expect(maskVolatile('t', null as never)).toBe('');
  });

  it('is not cut to 200, where the fingerprint is', () => {
    expect(maskVolatile('t', 'a '.repeat(150)).length).toBe(299);
    expect(fingerprint('t', 'a '.repeat(150)).length).toBe(200);
  });
});

describe('stripEngineNotes(storedResult)', () => {
  it('cuts at the FIRST engine note', () => {
    expect(stripEngineNotes('boom\n\n[Engine note: retry later]\n\n[Engine note: again]')).toBe('boom');
  });

  it('leaves a result that carries no note untouched, including the empty one', () => {
    expect(stripEngineNotes('boom')).toBe('boom');
    expect(stripEngineNotes('')).toBe('');
  });

  it('yields the empty string when the result is nothing but a note', () => {
    expect(stripEngineNotes('\n\n[Engine note: x')).toBe('');
  });

  it('needs a blank line before the tag: a single newline is not a note opening', () => {
    const one = 'boom\n[Engine note: single newline]';
    expect(stripEngineNotes(one)).toBe(one);
  });

  it('strips the notes before the fingerprint is taken, so the note never reaches it', () => {
    expect(fingerprint('t', stripEngineNotes('Boom\n\n[Engine note: x]'))).toBe(fingerprint('t', 'Boom'));
    expect(fingerprint('t', 'Boom\n\n[Engine note: x]')).toBe('boom [engine note: x]');
  });
});
