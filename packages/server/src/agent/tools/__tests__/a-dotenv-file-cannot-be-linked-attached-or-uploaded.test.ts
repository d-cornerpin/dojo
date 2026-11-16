// A project .env never leaves the Mac: no agent, the main one included, attaches it to mail or a text,
// copies it to another agent, uploads it to Drive, OneDrive or Slides, or makes a link to it.

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const { scratchDojo, UPLOADS, MAIN, HELPER } = await import('./scratch-dojo.js');
const { home, text } = await scratchDojo('dotenv-leaves', { 'code/site/.env.example': 'PORT=3000\n', 'code/site/.env': 'PORT=3000\n', 'code/site/.npmrc': 'registry=https://registry.example.com/\n' });
const dotenv = path.join(home, 'code', 'site', '.env');
const SECRET_REFUSAL = /sensitive-files block list/;

describe('a dotenv file cannot be linked, attached or uploaded', () => {
  it.each([
    ...UPLOADS(dotenv),
    ['send_to_agent', { agent: HELPER, payload: 'The settings.', intent: 'FYI', attach_paths: [dotenv] }],
    ['share_file', { path: dotenv }],
    ['share_publicly', { source_path: dotenv }],
  ])('main agent: %s is refused', async (name, args) => {
    expect(await text(MAIN, name, args)).toMatch(SECRET_REFUSAL);
  });

  it('a helper is refused too', async () => {
    expect(await text(HELPER, 'gmail_send', { to: 'someone@example.com', subject: 'x', body: 'x', attachments: [dotenv] })).toMatch(SECRET_REFUSAL);
  });
});
