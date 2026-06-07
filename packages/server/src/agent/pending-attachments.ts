// ════════════════════════════════════════
// Pending Attachments
// Per-agent buffer for files queued via show_to_user that should be
// attached to the agent's next persisted assistant message.
//
// Why a buffer instead of inserting an assistant message during the
// tool call: persisting an extra assistant row mid-tool-loop breaks
// the strict assistant→tool→assistant alternation the model expects,
// confuses the model into re-calling show_to_user, and inflates the
// chat with synthetic bubbles. Letting the runtime drain this buffer
// onto the agent's *next* assistant write keeps the alternation
// clean — the user sees a single bubble with text + thumbnail.
// ════════════════════════════════════════

export interface PendingAttachment {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: 'image' | 'pdf' | 'text' | 'office' | 'unknown';
}

const buffers = new Map<string, PendingAttachment[]>();

// v2.9.20 — captions parallel to the attachment buffer. show_to_user's
// `caption` arg was previously discarded (the model was expected to
// re-write it as its reply text). Now we capture each call's caption
// so that if the loop ends without the model writing terminal text,
// the engine's end-of-turn safety net can synthesize a final message
// using the caption(s) as the bubble text + the attached files.
const captionBuffers = new Map<string, string[]>();

export function queuePendingAttachments(
  agentId: string,
  attachments: PendingAttachment[],
  caption?: string,
): void {
  if (attachments.length === 0) return;
  const existing = buffers.get(agentId) ?? [];
  buffers.set(agentId, [...existing, ...attachments]);
  if (caption && caption.trim().length > 0) {
    const existingCaps = captionBuffers.get(agentId) ?? [];
    captionBuffers.set(agentId, [...existingCaps, caption.trim()]);
  }
}

export function drainPendingAttachments(agentId: string): PendingAttachment[] {
  const out = buffers.get(agentId) ?? [];
  if (out.length === 0) return [];
  buffers.delete(agentId);
  captionBuffers.delete(agentId);
  return out;
}

/**
 * Drain attachments AND any captions captured from show_to_user
 * calls in this turn. Used by the engine's end-of-turn safety net
 * when the model finished without writing terminal text.
 */
export function drainPendingAttachmentsWithCaptions(
  agentId: string,
): { attachments: PendingAttachment[]; captions: string[] } {
  const attachments = buffers.get(agentId) ?? [];
  const captions = captionBuffers.get(agentId) ?? [];
  buffers.delete(agentId);
  captionBuffers.delete(agentId);
  return { attachments, captions };
}

export function peekPendingAttachmentCount(agentId: string): number {
  return buffers.get(agentId)?.length ?? 0;
}

export function clearPendingAttachments(agentId: string): void {
  buffers.delete(agentId);
  captionBuffers.delete(agentId);
}
