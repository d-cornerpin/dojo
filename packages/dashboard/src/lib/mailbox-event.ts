// Parse an engine "MAILBOX EVENT" notification (the Gmail / Outlook inbox
// watchers) into just the fields worth showing the user, so non-wordy mode can
// render a clean email card instead of the raw engine framing ("This email was
// NOT sent to you…"), the Message ID, and the "Use `user_outlook_read`…" tool
// hint. The agent still sees the full content; this only affects display.
//
// Server format (services/gmail-watcher.ts, services/outlook-watcher.ts):
//   [SOURCE: OUTLOOK NOTIFICATION — <account> (<suffix>)]
//
//   [MAILBOX EVENT] <owner>'s <account> inbox just received an email. <framing…>
//
//   From: <from>
//   Subject: <subject>
//   Date: <date>
//   Preview: <snippet, possibly multi-line>
//   Message ID: <id>
//   Use `<tool>` to read the full body before deciding.

export interface MailboxEvent {
  /** The monitored mailbox that received the email (e.g. you@example.com). */
  account: string | null;
  from: string | null;
  subject: string | null;
  /** The preview snippet (not the full body — the agent reads that on demand). */
  body: string | null;
}

/**
 * Returns the parsed email-notification fields, or null if `content` isn't a
 * per-email MAILBOX EVENT detail message (e.g. the short "N new emails" summary
 * trigger, which has no From/Subject block, returns null and renders normally).
 */
export function parseMailboxEvent(content: string): MailboxEvent | null {
  // Both inbox-watcher framings render as the same clean card in non-wordy mode:
  // [MAILBOX EVENT] (third-party context) and [DIRECT MESSAGE] (a known sender
  // writing to the agent's own mailbox). The account still parses from the
  // [SOURCE: …] tag for the direct-message variant.
  if (!content.includes('[MAILBOX EVENT]') && !content.includes('[DIRECT MESSAGE]')) return null;

  // The per-email detail message has the From/Subject/Preview block; the
  // summary trigger does not. Require Subject so we only card-ify the detail.
  const subject = content.match(/^Subject:[ \t]*(.*)$/m)?.[1]?.trim() ?? null;
  if (subject === null) return null;

  const account =
    content.match(/\[MAILBOX EVENT\][^\n]*?'s[ \t]+(\S+)[ \t]+inbox/i)?.[1] ??
    content.match(/\[SOURCE:[^\]]*?NOTIFICATION[^\]]*?—[ \t]*([^\s()\]]+)/i)?.[1] ??
    null;

  const from = content.match(/^From:[ \t]*(.*)$/m)?.[1]?.trim() ?? null;

  // Preview can be multi-line; it runs until the "Message ID:" / "Use `…`" line.
  const body =
    content.match(/^Preview:[ \t]*([\s\S]*?)\n(?:Message ID:|Use `)/m)?.[1]?.trim() ??
    content.match(/^Preview:[ \t]*([\s\S]*)$/m)?.[1]?.trim() ??
    null;

  return { account, from, subject, body };
}
