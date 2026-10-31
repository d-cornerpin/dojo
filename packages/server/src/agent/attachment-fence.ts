// ════════════════════════════════════════════════════════════════════════════
// A CONTACT'S IMAGE OR PDF IS OTHER PEOPLE'S TEXT TOO (v3.5 K33 fix round 4, ruling 3).
//
// The inbound producers fence a contact's words at ingest; the image or PDF the contact sent is
// stored as the row's attachment and turned into model blocks each turn (`runtime.ts`
// `injectAttachmentBlocks`). Each such block from anyone but the owner is bracketed by its fence's
// head and end — the shape the tool door gives a received file — so every provider's message
// builder carries it fenced (`@dojo/shared` `attachmentBrackets`). The owner's own attachments (a
// dashboard upload, his own iMessage or MMS) are as he sent them, the same rule as his text.
// ════════════════════════════════════════════════════════════════════════════

import { createHmac, randomBytes } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { InboundMeta } from '@dojo/shared';
import { fenceAttachment, fenceExternal, type ExternalKind } from '../tools/external-content.js';
import { isOwnerIMessageRecipient } from '../services/safe-senders.js';
import { estimateTokens } from '../memory/budget.js';

export interface AttachmentFence { readonly kind: ExternalKind; readonly from: string; readonly rowId: string; drawn: number }

// The blocks are rebuilt on EVERY model call of a turn, so a fresh code per call would change the
// message's bytes each time and miss the prompt cache from there on. Each fence's code is instead
// keyed to its row and its place in the row, under a key drawn once per process: the same on every
// call, never derived from the content, and unknowable to the sender.
const CODE_KEY = randomBytes(32);
const codeOf = (fence: AttachmentFence): string => createHmac('sha256', CODE_KEY).update(`${fence.rowId}\0${fence.drawn++}`).digest('hex').slice(0, 8);

const KIND_OF: Readonly<Record<string, ExternalKind>> = { imessage: 'text message', sms: 'text message', teams: 'chat message', email: 'email', phone: 'transcript' };

/**
 * Whose attachments a stored row carries, from its routing record: `null` for the owner's (no
 * record is a dashboard upload; the bridge stamps the owner's relation; an MMS is the owner's when
 * it came from his number, as its text is), else the fence they go in. An unreadable record is
 * fenced: it cannot show the row is the owner's.
 */
export function attachmentFenceOf(inboundMeta: string | null | undefined, rowId: string): AttachmentFence | null {
  if (!inboundMeta) return null;
  let meta: Partial<InboundMeta>;
  try { meta = JSON.parse(inboundMeta) as Partial<InboundMeta>; } catch { return { kind: 'document', from: 'a received attachment', rowId, drawn: 0 }; }
  if (meta.channel === 'dashboard' || meta.channel === 'voice' || meta.relation === 'owner') return null;
  if ((meta.channel === 'imessage' || meta.channel === 'sms') && isOwnerIMessageRecipient(meta.sender)) return null;
  return { kind: KIND_OF[meta.channel ?? ''] ?? 'document', from: `an attachment from ${meta.sender ?? 'a contact'}`, rowId, drawn: 0 };
}

/** What one attachment's fence (its head and its end) costs the model: two text blocks, priced as the fit prices
 *  text (`memory/turn-attachments.ts` adds it to the attachment's charge, so the fit stays honest). */
export function attachmentFenceTokens(fence: AttachmentFence): number {
  const { head, end } = fenceAttachment(fence.kind, fence.from, '00000000');   // every code is 8 hex: the same length
  return estimateTokens(JSON.stringify([{ type: 'text', text: head }, { type: 'text', text: end }]));
}

/** One attachment's blocks: bracketed by its own fence when it came from outside. */
export function bracketed(fence: AttachmentFence | null, block: Anthropic.ContentBlockParam): Anthropic.ContentBlockParam[] {
  if (!fence) return [block];
  const { head, end } = fenceAttachment(fence.kind, fence.from, codeOf(fence));
  return [{ type: 'text', text: head }, block, { type: 'text', text: end }];
}

// v2.3.19 gap: the persisted pointer text says an attachment exists, so an empty hole makes the
// model hallucinate contents or deny the attachment was sent. The skip itself stays (a broken file
// must never kill the turn); this note is what makes the skip honest. A contact's file name is
// theirs, so it goes inside a fence below the engine's note.
export function droppedAttachmentNote(fence: AttachmentFence | null, kind: string, filename: string, reason: string): Anthropic.ContentBlockParam {
  const rest = `${reason}, so it is NOT shown to you. Do not describe or assume its contents. If the person you are talking to asks about it, say it failed to load and ask them to re-send it.]`;
  return {
    type: 'text',
    text: fence
      ? `[Engine note: the attached ${kind} named in the fence below ${rest}\n${fenceExternal(fence.kind, fence.from, `File name: ${filename}`, { code: codeOf(fence) })}`
      : `[Engine note: the attached ${kind} "${filename}" ${rest}`,
  };
}
