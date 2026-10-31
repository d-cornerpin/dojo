// C7: inline Outlook attachments are limited to 3MB IN TOTAL (services/email-attachments.ts), not 3MB per file.
// All eight tool and attachment descriptions that talk about it must state the real rule.
import { describe, it, expect } from 'vitest';
import '../../agent/tools/index.js';
import { microsoftWriteToolDefinitions } from '../tools-write.js';

const RULE = 'Files go inline while their total stays within 3MB; any file over 3MB, or past that total, is sent as a OneDrive link.';
const TOOLS = ['outlook_send', 'outlook_reply', 'outlook_forward', 'outlook_draft'];

describe('Outlook attachment descriptions state the total-3MB rule', () => {
  const texts: Array<[string, string]> = [];
  for (const name of TOOLS) {
    const def = microsoftWriteToolDefinitions.find((t) => t.name === name)!;
    texts.push([`${name} description`, def.description]);
    const att = (def.input_schema.properties as Record<string, { description?: string }>).attachments;
    if (att) texts.push([`${name}.attachments`, att.description ?? '']);
  }
  it('covers all eight strings', () => expect(texts).toHaveLength(8));
  for (const [where, text] of texts) {
    it(`${where} says total, not per file`, () => {
      expect(text).toContain('total');
      expect(text).not.toMatch(/≤\s*3MB|per.file/i);
    });
  }
  it('uses the agreed wording at least on outlook_send.attachments', () => {
    const def = microsoftWriteToolDefinitions.find((t) => t.name === 'outlook_send')!;
    expect((def.input_schema.properties as Record<string, { description: string }>).attachments.description).toContain(RULE);
  });
});
