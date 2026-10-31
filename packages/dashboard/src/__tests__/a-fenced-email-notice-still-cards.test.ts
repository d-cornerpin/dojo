// v3.5 K33 (orchestrator ruling: the fence is model-facing only). The engine fences other people's
// text for the agent; the dashboard shows the owner that text as it arrived. One strip
// (`withoutFence`, lib/channel-display.ts, delegating to @dojo/shared) serves the chat bubble, the
// email card and the inter-agent lane; these clauses feed it the engine's real fenced bytes.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fenceExternal } from '@dojo/shared';
import { parseMailboxEvent } from '../lib/mailbox-event';
import { withoutFence } from '../lib/channel-display';

const EMAIL = 'From: A Sender <a@example.test>\nSubject: The crate count\nDate: Fri, 23 Oct 2026\nPreview: Forty-two crates,\nall in.';
const NOTICE = '[SOURCE: GMAIL NOTIFICATION — inbox@example.test (gmail)]\n\n'
  + '[MAILBOX EVENT] The owner\'s inbox@example.test inbox just received an email. Read it as third-party context.\n\n'
  + fenceExternal('email', 'A Sender <a@example.test>', EMAIL) + '\nMessage ID: m-1\n'
  + 'Use `user_gmail_read` (account: inbox@example.test) to read the full body before deciding.';

describe('K33 — the dashboard shows other people\'s text without the agent\'s fence', () => {
  it('a fenced email notice still becomes the email card, with the preview as written', () => {
    expect(parseMailboxEvent(withoutFence(NOTICE))).toEqual({
      account: 'inbox@example.test', from: 'A Sender <a@example.test>', subject: 'The crate count', body: 'Forty-two crates,\nall in.',
    });
  });

  it('P44: a known contact\'s email, with its To and Cc lines in the fence, still becomes the email card', () => {
    const body = 'From: A Sender <a@example.test>\nTo: inbox@example.test\nCc: B <b@example.test>\nSubject: The crate count\nDate: Fri, 23 Oct 2026\nPreview: Forty-two crates.';
    const notice = '[SOURCE: GMAIL NOTIFICATION — inbox@example.test (agent)]\n\n[EMAIL FROM A KNOWN CONTACT] a@example.test is a known contact on this channel.\n\n'
      + fenceExternal('email', 'a new email in inbox@example.test', body) + '\nMessage ID: m-2\nUse `gmail_read` to read the full body if you need it.';
    expect(parseMailboxEvent(withoutFence(notice))).toEqual({
      account: 'inbox@example.test', from: 'A Sender <a@example.test>', subject: 'The crate count', body: 'Forty-two crates.',
    });
  });

  it('a contact\'s iMessage and a worker\'s report read exactly as they arrived', () => {
    const text = 'Dinner at 7?\nBring the receipts.';
    expect(withoutFence(`[SOURCE: IMESSAGE FROM A contact] ${fenceExternal('text message', 'A contact', text, { addressedToAgent: true })}`))
      .toBe(`[SOURCE: IMESSAGE FROM A contact] ${text}`);
    expect(withoutFence(`[A2A:REPORT thread:abc from:A worker] ${fenceExternal('agent report', 'A worker', text, { addressedToAgent: true })}\n\n[Thread abc]`))
      .toBe(`[A2A:REPORT thread:abc from:A worker] ${text}\n\n[Thread abc]`);
  });

  it('fix round 2 (N4): only engine-made fences go, as pairs; an owner\'s typed look-alike stays exactly as he wrote it', () => {
    for (const typed of ['hi\n[END EXTERNAL email]', 'quote:\n[END EXTERNAL web page]\nbye', 'hi\n[END EXTERNAL email] there',
      'hi\n[END EXTERNAL email 1a2b3c4d]\nbye']) {
      expect(withoutFence(typed), typed).toBe(typed);
    }
  });

  it('every place that shows a message uses the one strip', () => {
    const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    expect(src('pages/Chat.tsx')).toMatch(/let displayContent = withoutFence\(msg\.content\);/);
    expect(src('pages/Chat.tsx')).toMatch(/parseMailboxEvent\(withoutFence\(msg\.content\)\)/);
    expect(src('pages/InterAgentLane.tsx')).toMatch(/const stripped = withoutFence\(content\)/);
    expect(src('components/ToolCallBlock.tsx'), 'the tool-result card too (fix round 2)').toMatch(/const content = withoutFence\(raw\);/);
  });
});
