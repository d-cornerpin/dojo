// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18b round 1 — THE TURN'S ATTACHMENTS ARE COUNTED INSIDE THE FIT.
//
// The owner's image or PDF rides its message row as the `attachments` column; the block itself is
// injected AFTER the assembly (`agent/runtime.ts` `injectAttachmentBlocks`). So the token trim, the
// out-of-view fold and the compactor's own measure (`measureView`) never saw its cost, and only the
// post-budget reserve's slack absorbed it. Measured by the t264 review on a 200K window with a full view:
// a PDF at 80% of the room was still refused after 25 rounds, each round folding ONE recent exchange
// through a paid summary call (a quiet, paid crawl; roughly 60 more rounds to fit).
//
// Now each row whose attachments this turn will inject carries their cost (`attachmentTokens`), and
// `storedRowCost` adds it: the trim cuts the history the attachment needs, and the assemble step's
// out-of-view door folds it, in the same turn. One cost function, one round.
//
// The rows charged are the rows the injection will fill, by its own rule: user rows of the current turn
// (after the last assistant row that is not a tool call) among the ten newest attachment-bearing rows,
// images and PDFs only. Each block is priced as the boundary prices it (`lanes.ts` `messageTokens`: a PDF
// by its base64; an image at its ceiling, as the boundary prices an image it cannot size; an image is free on a
// model without vision, where it becomes a caption). An attachment over the room ALONE is charged what it will be shown as: its note
// (`kept-row-view.ts` `attachmentsWithinRoom`, the same room).
// ════════════════════════════════════════════════════════════════════════════════════════

import type { Message } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { estimateTokens, estimateTokensFromChars } from './budget.js';
import { messageTokens } from './lanes.js';
import { mediaNoteText } from './kept-row-view.js';
import { getModelCapabilities } from '../services/capabilities.js';
import { attachmentFenceOf, attachmentFenceTokens } from '../agent/attachment-fence.js';

type Attachment = { filename: string; mimeType: string; size: number; category: string };

/**
 * What one attachment costs as the injection will show it inside `roomTokens`, or 0 when it injects nothing. Priced
 * from the row's own record, no file read (this module is not a file door): a PDF by the base64 of its recorded size,
 * an image at the boundary's CEILING — its rule for an image it cannot size (`lanes.ts` `imageBlockTokens`), and the
 * safe direction: the injection may downscale it, never enlarge it.
 */
function attachmentTokens(att: Attachment, vision: boolean, roomTokens: number): number {
  const bytes = Number(att.size) || 0;
  let tokens: number;
  if (att.category === 'pdf') {
    const envelope = JSON.stringify([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: '' }, title: att.filename }]).length;
    tokens = estimateTokensFromChars(envelope + 4 * Math.ceil(bytes / 3));
  } else {
    if (!vision) return 0;
    tokens = messageTokens({ role: 'user', content: [{ type: 'image', source: { type: 'url', url: '' } }] as never });
  }
  if (tokens <= roomTokens) return tokens;
  const note = mediaNoteText({ image: att.category === 'image', mediaType: att.category === 'pdf' ? 'application/pdf' : att.mimeType, title: att.category === 'pdf' ? att.filename : undefined, bytes, tokens });
  return estimateTokens(JSON.stringify([{ type: 'text', text: note }]));
}

/** `rows` with each row whose attachments this turn will inject charged their cost (`attachmentTokens`). */
export function chargeTurnAttachments(agentId: string, modelId: string, rows: Message[], roomTokens: number): Message[] {
  const recent = getDb().prepare(`SELECT id, attachments, inbound_meta FROM messages WHERE agent_id = ? AND role = 'user' AND attachments IS NOT NULL
    ORDER BY created_at DESC, rowid DESC LIMIT 10`).all(agentId) as Array<{ id: string; attachments: string; inbound_meta: string | null }>;
  if (recent.length === 0) return rows;
  const byId = new Map(recent.map((r) => [r.id, r.attachments]));
  const metaOf = new Map(recent.map((r) => [r.id, r.inbound_meta]));
  let turnStart = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'assistant' && !/"type":"tool_use"/.test(rows[i].content)) { turnStart = i + 1; break; }
  }
  const caps = getModelCapabilities(modelId);
  const vision = caps.length === 0 || caps.includes('vision');
  return rows.map((m, i) => {
    const json = i >= turnStart && m.role === 'user' ? byId.get(m.id) : undefined;
    if (!json) return m;
    let atts: Attachment[];
    try { atts = JSON.parse(json) as Attachment[]; } catch { return m; }
    // v3.5 K33: a contact's image or PDF is injected inside its fence; its head and end are in the charge too.
    const fence = attachmentFenceOf(metaOf.get(m.id), m.id);
    const fenceTokens = fence ? attachmentFenceTokens(fence) : 0;
    const charge = atts.filter((a) => a.category === 'image' || a.category === 'pdf').reduce((t, a) => t + attachmentTokens(a, vision, roomTokens) + fenceTokens, 0);
    return charge > 0 ? { ...m, attachmentTokens: charge } as Message : m;
  });
}
