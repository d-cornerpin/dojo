// ════════════════════════════════════════════════════════════════════════════════════════
// microsoft/send-as-draft.ts — Outlook reply, reply-all and forward, sent so they carry the platform's send marker.
//
// Graph's `reply` / `replyAll` / `forward` queue the send directly and cannot take a custom header, so a reply-all
// that includes the agent's own mailbox could arrive before any record of it exists (P44 review C2). Instead the
// message is built as a draft (`createReply` / `createReplyAll` / `createForward`, the same payload), the recorded
// `x-platform-send-id` header (`services/platform-sends.ts`) is set IN the create call (Graph allows custom headers only at creation), and the draft is sent. Every Outlook
// send therefore carries the marker at send time, exactly like `sendMail`; the Sent Items Message-ID record stays as a second key.
// ════════════════════════════════════════════════════════════════════════════════════════

import { msGraphWrite } from './client.js';
import { graphSendHeaders, recordPlatformSend } from '../services/platform-sends.js';

type Result = Awaited<ReturnType<typeof msGraphWrite>>;

/** Send a reply, reply-all or forward of message `messageId` (already URL-encoded) through a marked draft. Returns the failing step's result, or the send's. */
export async function sendMarkedDraft(kind: 'reply' | 'replyAll' | 'forward', messageId: string, body: Record<string, unknown>, agentId: string, agentName: string, action: string, details: Record<string, unknown>, slot: string): Promise<Result> {
  const draftEndpoint = kind === 'forward' ? `me/messages/${messageId}/createForward` : kind === 'replyAll' ? `me/messages/${messageId}/createReplyAll` : `me/messages/${messageId}/createReply`;
  // Graph accepts custom headers (names starting `x-`) only when a message is CREATED and never after, so the marker rides in the create
  // call's `message` object, beside `comment` or the payload's own `message` properties (a `comment` is never combined with `message.body`).
  let headers: ReturnType<typeof graphSendHeaders>;
  try { headers = graphSendHeaders(); } catch (err) { return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), apiEndpoint: draftEndpoint } as Result; }   // record not saved: nothing is made, nothing sent
  const withMarker = { ...body, message: { ...(body.message as Record<string, unknown> | undefined), internetMessageHeaders: headers } };
  const made = await msGraphWrite('POST', draftEndpoint, withMarker, agentId, agentName, action, details, slot);
  const draft = made.data as { id?: string; internetMessageId?: string } | null;
  if (!made.ok || !draft?.id) return made.ok ? { ...made, ok: false, error: 'Graph made the draft but returned no id, so nothing was sent.' } : made;   // no key could be recorded: nothing is sent
  recordPlatformSend(draft.internetMessageId);   // second key, before the send: survives an Exchange that drops the custom header
  const sent = await msGraphWrite('POST', `me/messages/${encodeURIComponent(draft.id)}/send`, undefined, agentId, agentName, action, details, slot);
  return sent.ok ? sent : { ...sent, error: `${sent.error} (the draft was created and was NOT sent: it is still in the mailbox's Drafts folder)` };
}
