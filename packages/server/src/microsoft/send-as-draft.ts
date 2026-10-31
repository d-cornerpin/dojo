// ════════════════════════════════════════════════════════════════════════════════════════
// microsoft/send-as-draft.ts — Outlook reply, reply-all and forward, sent so they carry the platform's send marker.
//
// Graph's `reply` / `replyAll` / `forward` queue the send directly and cannot take a custom header, so a reply-all
// that includes the agent's own mailbox could arrive before any record of it exists (P44 review C2). Instead the
// message is built as a draft (`createReply` / `createReplyAll` / `createForward`, the same payload), the recorded
// `x-platform-send-id` header (`services/platform-sends.ts`) is set on the draft, and the draft is sent. Every Outlook
// send therefore carries the marker at send time, exactly like `sendMail`; the Sent Items Message-ID record stays as a second key.
// ════════════════════════════════════════════════════════════════════════════════════════

import { msGraphWrite } from './client.js';
import { graphSendHeaders } from '../services/platform-sends.js';

type Result = Awaited<ReturnType<typeof msGraphWrite>>;

/** Send a reply, reply-all or forward of message `messageId` (already URL-encoded) through a marked draft. Returns the failing step's result, or the send's. */
export async function sendMarkedDraft(kind: 'reply' | 'replyAll' | 'forward', messageId: string, body: Record<string, unknown>, agentId: string, agentName: string, action: string, details: Record<string, unknown>, slot: string): Promise<Result> {
  const draftEndpoint = kind === 'forward' ? `me/messages/${messageId}/createForward` : kind === 'replyAll' ? `me/messages/${messageId}/createReplyAll` : `me/messages/${messageId}/createReply`;
  const made = await msGraphWrite('POST', draftEndpoint, body, agentId, agentName, action, details, slot);
  const draftId = (made.data as { id?: string } | null)?.id;
  if (!made.ok || !draftId) return made.ok ? { ...made, ok: false, error: 'Graph made the draft but returned no id, so nothing was sent.' } : made;
  const marked = await msGraphWrite('PATCH', `me/messages/${encodeURIComponent(draftId)}`, { internetMessageHeaders: graphSendHeaders() }, agentId, agentName, action, details, slot);
  if (!marked.ok) return marked;   // an unmarked send is never made
  return msGraphWrite('POST', `me/messages/${encodeURIComponent(draftId)}/send`, undefined, agentId, agentName, action, details, slot);
}
