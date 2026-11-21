// The one delivery of a finished picture, speech, song or video: copied into the agent's uploads, posted in its chat
// with no caption, and texted back by iMessage (a video as its link) when the request came by iMessage.
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { InboundMeta } from '@dojo/shared';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { deliveredResult, insertMessageIfAbsent } from '../memory/message-store.js';
import { settleAskOnAsyncResult } from '../work/ask-settlement.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { homeDir } from '../home.js';
import { getMessagesByIds } from '../memory/store.js';
import { engineMayRouteTo } from '../agent/access/engine-route.js';
import { replyAddressFor } from '../agent/v2/channel-sender.js';
import { queueReply } from '../agent/v2/deliveries.js';
import { createPublicShare } from './public-share.js';

const logger = createLogger('media-delivery');

export interface FinishedMedia {
  kind: 'image' | 'audio' | 'music' | 'video';
  agentId: string;
  jobId: string;
  title: string | null;
  /** The generated file, as the provider call returned it. */
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  /** The request the job serves, stamped on the job when the tool was called. */
  conversationId: string | null;
  requestMessageId: string | null;
}

const CATEGORY = { image: 'image', audio: 'audio', music: 'audio', video: 'video' } as const;
/** The plain word for each kind, in what the agent is told. */
export const MEDIA_WORD = { image: 'picture', audio: 'audio', music: 'music', video: 'video' } as const;
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

/** Posts the file, queues it for a phone when one is owed, and tells the agent where it went. */
export async function deliverMedia(m: FinishedMedia): Promise<void> {
  const dir = path.join(homeDir(), '.dojo', 'uploads', m.agentId);
  const name = `${(m.title && slug(m.title)) || m.kind}-${m.jobId.replace(/^(gen|vid)_/, '').slice(0, 8)}${path.extname(m.filePath)}`;
  let file = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(m.filePath, file);
  } catch (err) {
    file = m.filePath;
    logger.warn('media delivery: the copy into the uploads folder failed, the generated file is posted', {
      jobId: m.jobId, error: err instanceof Error ? err.message : String(err),
    });
  }
  const attachment = { fileId: uuidv4(), filename: path.basename(file), mimeType: m.mimeType, size: m.sizeBytes, path: file, category: CATEGORY[m.kind] };
  const id = uuidv4();
  // The engine writes no caption in the agent's voice: the agent is told where the file went and adds its own words.
  insertMessageIfAbsent({
    id, agentId: m.agentId, role: 'assistant', content: '', attachments: JSON.stringify([attachment]),
    ...deliveredResult(m.conversationId, m.requestMessageId),
  });
  broadcast({
    type: 'chat:message', agentId: m.agentId,
    message: {
      id, agentId: m.agentId, role: 'assistant' as const, content: '', attachments: [attachment],
      tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString(),
    },
  });
  broadcast({ type: 'chat:chunk', agentId: m.agentId, messageId: id, content: '', done: true, modelId: null });
  settleAskOnAsyncResult({ agentId: m.agentId, askMessageId: m.requestMessageId, resultMessageId: id });
  const phone = await queueForPhone(m, file);
  postAgentNotice({
    toAgentId: m.agentId, fromName: 'Media delivery', intent: 'image_delivery_outcome', selfIntro: false,
    brief: `your ${MEDIA_WORD[m.kind]} was posted in the dashboard`
      + `${phone ? ` and is being texted to the person who asked by iMessage${m.kind === 'video' ? ' as a link' : ''}` : ''}`
      + ', with no caption: the Dojo wrote no words around it. If you want to say something about it, say it in your own words.',
  });
}

/** The person who asked by iMessage gets the file through the one reply sender; true when it was queued.
 *  A phone that cannot be reached never undoes the dashboard post. */
async function queueForPhone(m: FinishedMedia, file: string): Promise<boolean> {
  try {
    if (!engineMayRouteTo(m.agentId, 'imessage')) return false;
    const raw = m.requestMessageId ? getMessagesByIds([m.requestMessageId])[0]?.inboundMeta : null;
    const asked = raw ? (JSON.parse(raw) as Partial<InboundMeta>) : null;
    const address = asked?.channel === 'imessage' && asked.sender ? replyAddressFor({ ...asked, channel: 'imessage' }) : null;
    if (!address) return false;
    const root = m.requestMessageId ? { kind: 'ask' as const, id: m.requestMessageId, sourceMessageId: m.requestMessageId, conversationId: m.conversationId } : null;
    // A video is too big for a text, so its link goes instead.
    const link = m.kind === 'video' ? `Download: ${createPublicShare({ sourcePath: file }).url}` : '';
    const queued = await queueReply({ agentId: m.agentId, turnNumber: null, root, text: link, address, files: link ? [] : [file], kind: 'download-links' });
    return !!queued;
  } catch (err) {
    logger.warn('media delivery: the phone copy was not queued', { jobId: m.jobId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
