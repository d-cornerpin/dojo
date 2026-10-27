import { describe, it, expect } from 'vitest';
import { newTextOf } from '../mail-quoted-text.js';

describe('newTextOf — the sender\'s own text, with quoted/forwarded mail cut', () => {
  it('cuts a single-line On…wrote: header and keeps the reply above it', () => {
    const body =
      'Yes, go ahead.\n\n' +
      'On Mon, Oct 5, 2026 at 9:00 AM Agent <agent@example.org> wrote:\n' +
      '> Shall I close the task?';
    expect(newTextOf(body)).toBe('Yes, go ahead.');
  });

  it('cuts the two-line-wrapped On…wrote: header the same way', () => {
    const body =
      'Yes, go ahead.\n\n' +
      'On Mon, Oct 5, 2026 at 9:00 AM Agent\n' +
      '<agent@example.org> wrote:\n' +
      '> Shall I close the task?';
    expect(newTextOf(body)).toBe('Yes, go ahead.');
  });

  it('drops inline > quoted lines and keeps the text between them', () => {
    const body = '> quoted\nreal text\n> more quoted';
    expect(newTextOf(body)).toBe('real text');
  });

  it('cuts an Original Message block and keeps the reply above it', () => {
    const body =
      'Approved.\n\n' +
      '-----Original Message-----\n' +
      'From: x\n' +
      'Sent: y';
    expect(newTextOf(body)).toBe('Approved.');
  });

  it('returns nothing when the whole message is a forwarded block or is blank', () => {
    const body =
      '---------- Forwarded message ---------\n' +
      'From: x';
    expect(newTextOf(body)).toBe('');
    expect(newTextOf('')).toBe('');
    expect(newTextOf('   \n\n')).toBe('');
  });

  it('cuts an Outlook From:/Sent: header block and keeps the reply above it', () => {
    const body =
      'Thanks.\n\n' +
      'From: A <a@example.org>\n' +
      'Sent: Monday\n' +
      'To: B\n' +
      'Subject: Re: x\n\n' +
      'old text';
    expect(newTextOf(body)).toBe('Thanks.');
  });

  it('does not cut a line that merely contains wrote: mid-sentence', () => {
    const body = 'I wrote: it is done';
    expect(newTextOf(body)).toBe('I wrote: it is done');
  });

  it('normalises CRLF to LF and leaves no carriage returns', () => {
    const body = 'first\r\n' + 'second\r\n' + 'third';
    expect(newTextOf(body)).toBe('first\nsecond\nthird');
    expect(newTextOf(body)).not.toContain('\r');
  });
});
