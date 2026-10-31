// Gmail's message payload is a tree of MIME parts. An attachment is a part, at any depth, with a
// non-empty `filename` and either inline data (small) or an `attachmentId` that needs a separate fetch.

export type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
};

export function collectAttachmentParts(part: GmailMessagePart, out: GmailMessagePart[]): void {
  if (part.filename && part.filename.length > 0 && (part.body?.attachmentId || part.body?.data)) {
    out.push(part);
  }
  if (part.parts) {
    for (const child of part.parts) collectAttachmentParts(child, out);
  }
}

/** Attachments a model can download: every filed part with an attachmentId. */
export function downloadableAttachments(payload: GmailMessagePart | undefined): GmailMessagePart[] {
  if (!payload) return [];
  const all: GmailMessagePart[] = [];
  collectAttachmentParts(payload, all);
  return all.filter((p) => p.body?.attachmentId);
}
