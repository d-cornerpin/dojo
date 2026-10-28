import { stripHtmlTags } from '../agent/html-text.js';

export interface GmailBodyPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailBodyPart[];
}

function decode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

// Every leaf part that carries inline text and is not an attachment, in message order.
function collectTextLeaves(part: GmailBodyPart, out: GmailBodyPart[]): void {
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) collectTextLeaves(child, out);
    return;
  }
  const isAttachment = !!(part.filename && part.filename.length > 0) || !!part.body?.attachmentId;
  if (!isAttachment && part.body?.data) out.push(part);
}

/** The readable text of a Gmail message: the first text/plain part anywhere in the tree, else the first text/html part with its tags stripped, else any other inline text, else ''. */
export function extractGmailBodyText(payload: GmailBodyPart | null | undefined): string {
  if (!payload) return '';
  const leaves: GmailBodyPart[] = [];
  collectTextLeaves(payload, leaves);
  const type = (p: GmailBodyPart) => (p.mimeType ?? '').toLowerCase();
  const plain = leaves.find((p) => type(p) === 'text/plain');
  if (plain) return decode(plain.body!.data!);
  const html = leaves.find((p) => type(p) === 'text/html');
  if (html) return stripHtmlTags(decode(html.body!.data!));
  const other = leaves.find((p) => type(p) === '');
  return other ? decode(other.body!.data!) : '';
}
