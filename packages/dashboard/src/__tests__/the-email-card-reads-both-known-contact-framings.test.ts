import { describe, it, expect } from 'vitest';
import { parseMailboxEvent } from '../lib/mailbox-event';

const body = (tag: string) => `${tag}\nFrom: Pat <pat@example.test>\nSubject: Lunch\nPreview: Are we on?\nMessage ID: abc`;

describe('email card framings', () => {
  it.each(['[DIRECT MESSAGE]', '[EMAIL FROM A KNOWN CONTACT]', '[MAILBOX EVENT]'])('%s makes a card', (tag) => {
    expect(parseMailboxEvent(body(tag))?.subject).toBe('Lunch');
  });
  it('plain text is not a card', () => {
    expect(parseMailboxEvent('Subject: x')).toBeNull();
  });
});
