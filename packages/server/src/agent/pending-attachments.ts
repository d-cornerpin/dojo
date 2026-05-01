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

export function queuePendingAttachments(agentId: string, attachments: PendingAttachment[]): void {
  if (attachments.length === 0) return;
  const existing = buffers.get(agentId) ?? [];
  buffers.set(agentId, [...existing, ...attachments]);
}

export function drainPendingAttachments(agentId: string): PendingAttachment[] {
  const out = buffers.get(agentId) ?? [];
  if (out.length === 0) return [];
  buffers.delete(agentId);
  return out;
}

export function peekPendingAttachmentCount(agentId: string): number {
  return buffers.get(agentId)?.length ?? 0;
}

export function clearPendingAttachments(agentId: string): void {
  buffers.delete(agentId);
}
