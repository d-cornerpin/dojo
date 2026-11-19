// Stores one new inbound mail for the main agent, whichever provider read it: its notice row, inbound meta and
// live card. One from the owner, from a sender on that mailbox's approved list, or to the agent's own mailbox wakes
// the agent; any other is an unauthorized row that owes no reply, drives no turn, and shows in the agent's EVENTS
// lane at its next turn.

import { v4 as uuidv4 } from 'uuid';
import { resolveOrCreateConversation } from '../memory/conversations.js';
import { recordInboundMeta } from '../agent/v2/inbound-channel.js';
import { insertInboundMessageIfAbsent } from '../work/ask-title.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getOwnerName, getPrimaryAgentId } from '../config/platform.js';
import { onMailList, senderWakes } from './channel-safe-senders.js';
import { ownerEmailCommandNote } from './mail-owner-intake.js';
import { mailNoticeContent } from '../tools/inbound-fences.js';
import type { MailAccountView, MailItem, MailProvider } from './mail-watcher.js';

const logger = createLogger('mail-record');

/** Stores one mail: 'wakes' or 'waits' for a first sighting, 'seen' when an earlier poll already stored it. */
export async function recordMail(p: Pick<MailProvider<{ id: string }>, 'name' | 'company'>, view: MailAccountView, mail: MailItem): Promise<'wakes' | 'waits' | 'seen'> {
  const primaryId = getPrimaryAgentId();
  const ownerName = getOwnerName();
  const notifyAccount = view.email ?? view.kind;
  // Direct to the agent: its own mailbox, from a safe sender (a user mailbox is the human's mail, never answered
  // for them) or the owner's own email the provider confirmed (`mail-owner-intake.ts`).
  const ownerMail = await mail.owner();
  const isDirectToAgent = ownerMail.state === 'confirmed' || (view.kind === 'agent' && onMailList(p.name, view.id, mail.fromAddr));
  const content = mailNoticeContent({
    provider: p.name === 'gmail' ? 'GMAIL' : 'OUTLOOK', accountSuffix: `${view.kind === 'user' ? "user's" : "agent's"} ${p.company} account`, account: notifyAccount, ownerName,
    kind: view.kind, fromAddr: mail.fromAddr, from: mail.from, subject: mail.subject, date: mail.date, snippet: mail.snippet, messageId: mail.id,
    directToAgent: isDirectToAgent, toolHint: `${view.kind === 'agent' ? '' : 'user_'}${p.name}_read`, addressing: mail.addressing,
    ownerEmail: ownerMail.state === 'none' ? undefined : ownerMail,
  }) + await ownerEmailCommandNote(ownerMail);

  const msgId = uuidv4();
  // Conversation identity is provider + sender + thread, so two threads from one sender are two conversations.
  const conversationId = resolveOrCreateConversation(primaryId, {
    channel: 'email', provider: p.name, counterpartyId: mail.fromAddr || mail.from, threadRoot: mail.threadRoot,
  });
  // Structured routing metadata: `authorized` is the auto-reply verdict, so a user-kind mailbox or an unknown
  // sender is read as a notification and never answered for the human.
  const inboundMetaObj = {
    channel: 'email' as const,
    accountKind: view.kind,
    authorized: isDirectToAgent,
    sender: mail.fromAddr || mail.from,
    emailMessageId: mail.id,
    emailService: p.name,
    emailAccount: notifyAccount,
    emailSubject: mail.subject,
    mailAddressing: mail.addressing,
    ...(ownerMail.state === 'confirmed' ? { relation: 'owner' as const, ownerWords: ownerMail.words, ownerWordsAt: mail.receivedAt } : {}),
  };
  const stored = insertInboundMessageIfAbsent({
    id: msgId,
    agentId: primaryId,
    role: 'user',
    content,
    conversationId,
    externalMessageId: mail.id,
    channel: inboundMetaObj.channel,
    senderId: inboundMetaObj.sender,
    authorized: inboundMetaObj.authorized,
  });
  // null: an earlier poll stored this mail (its processed-list save was lost); no second live card, no second wake.
  if (stored === null) return 'seen';
  recordInboundMeta(msgId, inboundMetaObj);
  // The same inbound_meta and conversation binding as the row, so live and refetched attribution agree.
  broadcast({
    type: 'chat:message',
    agentId: primaryId,
    message: {
      id: msgId,
      agentId: primaryId,
      role: 'user' as const,
      content,
      conversationId,
      inboundMeta: JSON.stringify(inboundMetaObj),
      tokenCount: null,
      modelId: null,
      cost: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
    },
  });
  logger.info('New email recorded for the main agent', { accountId: view.id, messageId: mail.id });
  return senderWakes(p.name, view, mail.fromAddr) ? 'wakes' : 'waits';
}
