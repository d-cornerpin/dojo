// The send-tool descriptions must not promise that a text is never refused: while a turn is
// delivering a reminder, a text to anyone but the owner is refused once (refusal-gates.ts).
import { describe, it, expect } from 'vitest';
import { toolDefinitions } from '../../tools/definitions.js';

const desc = (name: string): string => toolDefinitions.find((t) => t.name === name)!.description;

describe('the send-tool descriptions do not overpromise a never-refuse', () => {
  for (const name of ['imessage_send', 'sms_send']) {
    it(`${name} stops saying the engine never refuses a text`, () => {
      const d = desc(name);
      expect(d).not.toContain('never refuses a text');
      expect(d).toContain('refused once');
    });
  }
});
