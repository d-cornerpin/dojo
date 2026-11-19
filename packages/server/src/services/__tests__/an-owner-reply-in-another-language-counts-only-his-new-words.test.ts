// The owner's words in a reply are his new text only, whatever language his mail program writes the
// "who wrote this" line in: that line goes with its `>` quote, and his own lines between quotes stay.
import { describe, it, expect } from 'vitest';
import { newTextOf } from '../mail-quoted-text.js';

describe('an owner reply in another language counts only his new words', () => {
  it.each([
    'Am Mo., 12. Okt. 2026 um 09:00 Uhr schrieb Agent <agent@example.com>:',
    'Le lun. 12 oct. 2026 à 09:00, Agent <agent@example.com> a écrit :',
    'El lun, 12 oct 2026 a las 9:00, Agent (<agent@example.com>) escribió:',
  ])('%s', (attribution) => {
    const body = `Ja, bitte.\n\n${attribution}\n> Shall I send the invoice?\n> It is ready.`;
    expect(newTextOf(body)).toBe('Ja, bitte.');
  });

  it.each([
    ['Answers below:\n> Shall I pay the invoice?\nYes, pay it today.', 'Yes, pay it today.'],
    ['My notes:\n> Approve the three items?\nAll approved, go ahead.', 'All approved, go ahead.'],
    ['On the recipient:\n> Send it to Pat?\nI meant send it to Sam, not Pat.', 'I meant send it to Sam, not Pat.'],
  ])('an interleaved reply keeps his words: %s', (body, words) => {
    expect(newTextOf(body)).toContain(words);
  });
});
