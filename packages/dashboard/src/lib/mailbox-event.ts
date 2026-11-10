// Parses an engine MAILBOX EVENT notice into the card's display fields; the agent still sees everything.

export interface MailboxEvent {
  account: string | null;
  from: string | null;
  subject: string | null;
  body: string | null;
}

export function parseMailboxEvent(content: string): MailboxEvent | null {
  if (!content.includes('[MAILBOX EVENT]') && !content.includes('[EMAIL FROM A KNOWN CONTACT]') && !content.includes('[DIRECT MESSAGE]')) return null;

  const subject = content.match(/^Subject:[ \t]*(.*)$/m)?.[1]?.trim() ?? null;
  // Subject marks the per-email detail; the "N new emails" summary has none and is not carded.
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
