// The turn's attachments are counted inside the fit. The block is injected after assembly
// (`agent/runtime.ts` `injectAttachmentBlocks`), so each row it will fill carries `attachmentTokens`, which
// `storedRowCost` adds. Rows charged follow the injection's rule: current-turn user rows among the ten
// newest with attachments.

import type { Message } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { estimateTokens, estimateTokensFromChars } from './budget.js';
import { messageTokens } from './lanes.js';
import { mediaNoteText } from './kept-row-view.js';
import { getModelCapabilities } from '../services/capabilities.js';
import { attachmentFenceOf, attachmentFenceTokens } from '../tools/inbound-fences.js';

type Attachment = { filename: string; mimeType: string; size: number; category: string };

/** Cost of one attachment as injected inside `roomTokens`: a PDF by base64 size, an image at the boundary's
 *  ceiling (safe: injection may downscale, never enlarge), 0 without vision; over the room, its note. */
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
    // A contact's attachment is injected inside its fence; the fence head and end are in the charge too.
    const fence = attachmentFenceOf(metaOf.get(m.id), m.id);
    const fenceTokens = fence ? attachmentFenceTokens(fence) : 0;
    const charge = atts.filter((a) => a.category === 'image' || a.category === 'pdf').reduce((t, a) => t + attachmentTokens(a, vision, roomTokens) + fenceTokens, 0);
    return charge > 0 ? { ...m, attachmentTokens: charge } as Message : m;
  });
}
