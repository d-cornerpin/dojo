// ════════════════════════════════════════════════════════════════════════════
// COMMUNICATION verbs: chat attachments (show_to_user), publishing (share_file,
// share_publicly), iMessage, SMS, and voice calls. Bodies relocated from the
// executor switch unchanged; share_*'s sharePathGuard moved with its body, not re-declared.
// The three dynamic `await import('.../twilio/voice-outbound.js')` calls MUST stay
// dynamic: that module's top level reads config/platform.js, which lands in the toolbox
// graph ahead of the partial vi.mock in the suites. The sharePathGuard body calls are
// live protections; do not drop them.
// ════════════════════════════════════════════════════════════════════════════

import * as effectFs from '../../effects/fs.js';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { ToolErrorCode } from '@dojo/shared';
import { getDb } from '../../../db/connection.js';
// The four outbound-send walls below keep position, message, and audit row; only
// the predicate moved to this agent's own channel grant, an owner-editable row.
import { mayUseChannel, mayReachOthersOn } from '../../access/read.js';
import { writeToolReceipt } from '../../../receipts/store.js';
import { turnContext } from '../../turn-context.js';
import { refuseSendWithNoRecipient, routedReplyWords } from '../../v2/send-recipient.js';
import { sharePathGuard } from '../../path-guards.js';
import { auditLog, linkReach, permissionDeniedMessage, registerSharedFile } from '../util.js';
import { appendTeamsSafeSender, appendMailSafeSender } from '../../../services/channel-safe-senders.js';
import { createPublicShare } from '../../../services/public-share.js';
import { executeSmsSend } from '../../../twilio/sms-outbound.js';
import { isEmailSendingEnabled } from '../../../google/auth.js';
import { getPrimaryGoogleAccount } from '../../../google/accounts.js';
import { isMsEmailSendingEnabled } from '../../../microsoft/auth.js';
import { getPrimaryMicrosoftAccount } from '../../../microsoft/accounts.js';
import { parseSafeSenders, reloadApprovedSenders, getSafeSenders, getIMBridgeStatus, findSafeSenderByAddress, sendIMessageWithAttachments, MAX_IMESSAGE_FILE_BYTES } from '../../../services/imessage-bridge.js';
import { iMessageListHasHumanOwner } from '../../../services/imessage-owner-gate.js';
import { getSmsReachability, describeSmsRecipients } from '../../../services/capability-registry.js';
import { queuePendingAttachments } from '../../pending-attachments.js';
import { syncSafeSenderToContacts } from '../../../contacts/from-safe-senders.js';
import type { ToolHandlerMap } from '../handler.js';
import { homeDir } from '../../../home.js';
import { userWords, currentAddress } from '../../v2/turn-address.js';
import { ownerAskedInThisTurn } from '../../../work/row-authority.js';

const ADD_SENDER_NEEDS_OWNER = 'Adding someone to the approved list needs the owner to ask for it in his own message. Ask him, and do it when he says so.';

export const commsHandlers: ToolHandlerMap = {
  async "share_file"({ agentId, args }) {
    let content = '';
    let isError = false;
    let errorCode: ToolErrorCode | undefined;
    // Minting a public URL is a read that leaves the box: same sensitive-path list
    // and file_read permission every read tool uses.
    const shareGuard = await sharePathGuard(agentId, 'share_file', args.path as string);
    if (!shareGuard.allowed) {
      auditLog(agentId, 'share_file', shareGuard.absPath, 'denied', shareGuard.reason);
      content = shareGuard.blockedMessage ?? permissionDeniedMessage(shareGuard.reason, agentId);
      isError = true; errorCode = 'PERMISSION_DENIED';
      return { content, isError, ...(errorCode !== undefined ? { errorCode } : {}) };
    }
    const sharePath = shareGuard.absPath;
    if (!path.isAbsolute(sharePath)) {
      content = 'Error: Path must be absolute. Use ~ for home directory.';
      isError = true;
      return { content, isError, ...(errorCode !== undefined ? { errorCode } : {}) };
    }
    if (!effectFs.existsSync(sharePath)) {
      content = `Error: File not found: ${sharePath}`;
      isError = true;
      return { content, isError, ...(errorCode !== undefined ? { errorCode } : {}) };
    }
    const stat = effectFs.statSync(sharePath);
    if (stat.isDirectory()) {
      content = `Error: ${sharePath} is a directory, not a file. Use file_list to see its contents.`;
      isError = true;
      return { content, isError, ...(errorCode !== undefined ? { errorCode } : {}) };
    }
    const downloadUrl = registerSharedFile(agentId, sharePath);
    if (!downloadUrl) {
      content = `Error: Failed to register file for sharing.`;
      isError = true;
      return { content, isError, ...(errorCode !== undefined ? { errorCode } : {}) };
    }
    const filename = path.basename(sharePath);
    content = `Download link for ${filename}: ${downloadUrl}\n\n${linkReach(downloadUrl)}`;
    auditLog(agentId, 'share_file', sharePath, 'success', downloadUrl);
    return { content, isError, ...(errorCode !== undefined ? { errorCode } : {}) };
  },

  async "show_to_user"({ agentId, args }) {
    let content = '';
    let isError = false;
    const filePaths = args.file_paths as string[] | undefined;
    const caption = (args.caption as string | undefined) ?? '';
    // The caption is captured as an end-of-turn safety net: if the model writes no
    // terminal text after this call, the engine surfaces it so files don't vanish silently.
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      content = 'Error: file_paths is required and must be a non-empty array of absolute file paths.';
      isError = true;
      return { content, isError };
    }
    if (filePaths.length > 10) {
      content = 'Error: too many files (max 10 per call). Make multiple show_to_user calls if needed.';
      isError = true;
      return { content, isError };
    }

    const uploadsDir = path.join(homeDir(), '.dojo', 'uploads', agentId);
    try { effectFs.mkdirSync(uploadsDir, { recursive: true }); } catch { /* best effort */ }

    const guessMime = (filename: string): string => {
      const ext = path.extname(filename).toLowerCase();
      if (ext === '.png') return 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
      if (ext === '.gif') return 'image/gif';
      if (ext === '.webp') return 'image/webp';
      if (ext === '.pdf') return 'application/pdf';
      if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.js', '.ts', '.py', '.sh', '.yaml', '.yml'].includes(ext)) return 'text/plain';
      if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      if (ext === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      return 'application/octet-stream';
    };
    const categorize = (mimeType: string, filename: string): 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'video' | 'unknown' => {
      if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) return 'image';
      if (mimeType === 'application/pdf') return 'pdf';
      if (mimeType.startsWith('audio/')) return 'audio';
      if (mimeType.startsWith('video/')) return 'video';
      const ext = path.extname(filename).toLowerCase();
      if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.webm'].includes(ext)) return 'audio';
      if (['.mp4', '.mov', '.mkv', '.avi'].includes(ext)) return 'video';
      if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.js', '.ts', '.py', '.sh', '.yaml', '.yml'].includes(ext)) return 'text';
      if (['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) return 'office';
      if (mimeType.startsWith('text/')) return 'text';
      return 'unknown';
    };

    const attachments: Array<{ fileId: string; filename: string; mimeType: string; size: number; path: string; category: 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'video' | 'unknown' }> = [];
    for (const srcPath of filePaths) {
      try {
        if (!effectFs.existsSync(srcPath)) {
          content = `Error: file not found: ${srcPath}`;
          isError = true;
          break;
        }
        const stat = effectFs.statSync(srcPath);
        if (!stat.isFile()) {
          content = `Error: not a file: ${srcPath}`;
          isError = true;
          break;
        }
        const filename = path.basename(srcPath);
        const mimeType = guessMime(filename);
        const category = categorize(mimeType, filename);

        // show_to_user is for inline chat media; documents belong in the CANVAS.
        // Reject them here so weaker models get pointed at the right surface.
        if (category === 'pdf' || category === 'text' || category === 'office' || category === 'unknown') {
          content = `Error: "${filename}" is a document, not an image, show_to_user is for images (and short audio/video clips) shown inline in the chat. Documents render in the CANVAS: a canvas-renderable file auto-opens the moment you write it (file_write, or creating a Word/Excel/PDF), or call canvas_render({ path: "${srcPath}" }) to (re)open it. Using show_to_user here would give the user a useless download chip instead of a readable preview.`;
          isError = true;
          break;
        }

        // Use the source directly if it is already in this agent's uploads dir; else
        // copy it in so the dashboard /api/upload/file/<agentId>/<name> route serves it.
        let destPath = srcPath;
        if (path.dirname(path.resolve(srcPath)) !== path.resolve(uploadsDir)) {
          const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const storedName = `${Date.now()}_${safeFilename}`;
          destPath = path.join(uploadsDir, storedName);
          effectFs.copyFileSync(srcPath, destPath);
        }

        attachments.push({
          fileId: uuidv4(),
          filename,
          mimeType,
          size: stat.size,
          path: destPath,
          category,
        });
      } catch (err) {
        content = `Error processing ${srcPath}: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
        break;
      }
    }
    if (isError) return { content, isError };

    // Queue for the agent's NEXT assistant message instead of inserting a synthetic
    // message: mid-loop insertion broke the alternation invariant; the runtime drains
    // this queue when it persists that message.
    queuePendingAttachments(agentId, attachments, caption);

    const fileList = attachments.map(a => {
      const url = registerSharedFile(agentId, a.path);
      return url
        ? `${a.filename} (${a.category}) -> shareable link: ${url}`
        : `${a.filename} (${a.category})`;
    }).join('\n');
    content = `Queued ${attachments.length} file(s) for your next reply (they attach as thumbnails):\n${fileList}\nWhen you point the user to a file, give them the shareable link above, never a raw file path. Now write your reply text in your next assistant message. Do NOT call show_to_user again for these same files.`;
    return { content, isError };
  },

  async "add_safe_sender"({ agentId, args }) {
    let content = '';
    let isError = false;
    const channelArg = args.channel as string | undefined;
    const addressArg = args.address as string | undefined;
    if (!channelArg || !addressArg) {
      content = 'Error: both `channel` and `address` are required.';
      isError = true;
      return { content, isError };
    }
    // Who the Dojo may reach changes only on the owner's own words in the message this turn answers.
    if (!ownerAskedInThisTurn(agentId, args.user_quote).ok) return { content: ADD_SENDER_NEEDS_OWNER, isError: true };
    const userQuote = String(args.user_quote).trim();
    const validChannels = ['imessage', 'gmail', 'outlook', 'teams'];
    if (!validChannels.includes(channelArg)) {
      content = `Error: channel must be one of: ${validChannels.join(', ')}`;
      isError = true;
      return { content, isError };
    }
    const address = addressArg.trim();
    if (!address) {
      content = 'Error: address is empty.';
      isError = true;
      return { content, isError };
    }
    const name = ((args.name as string | undefined) ?? address).trim() || address;
    const description = (args.description as string | undefined)?.trim() || undefined;
    const sharingLevel = (args.sharing_level as string | undefined) ?? 'dont_overshare';
    const isAgent = args.is_agent === true;
    const validLevels = ['open_book', 'dont_overshare', 'cautious', 'project_only'];
    if (!validLevels.includes(sharingLevel)) {
      content = `Error: sharing_level must be one of: ${validLevels.join(', ')}`;
      isError = true;
      return { content, isError };
    }
    if (sharingLevel === 'project_only' && !description) {
      content = 'Error: sharing_level=project_only requires a description naming the specific project.';
      isError = true;
      return { content, isError };
    }
    // Audit gets a truncated quote; the full quote stays in the tool-call args.
    const auditQuote = userQuote.length > 200
      ? userQuote.slice(0, 200) + '…'
      : userQuote;

    const sender = {
      address,
      name,
      description,
      is_primary: false,
      sharing_level: sharingLevel as 'open_book' | 'dont_overshare' | 'cautious' | 'project_only',
      is_agent: isAgent,
    };

    try {
      if (channelArg === 'imessage') {
        // Own config key with a bridge cache: read, dedup, write, hot-reload so the
        // bridge picks up the sender at once (same flow as the Settings.tsx write path).
        const db = getDb();
        const row = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
        const existing = parseSafeSenders(row?.value ?? null);
        // The agent never creates or changes the owner: with no human owner set the
        // entry would sit alone, and owner rights come only from Settings.
        if (!iMessageListHasHumanOwner()) {
          content = 'I cannot add this person yet: no owner is set for iMessage. Ask the owner to set their own number in Settings → Channels → iMessage Bridge first, then I can add others.';
          isError = true;
          auditLog(agentId, 'add_safe_sender', `imessage:${address}`, 'denied', `no owner set; quote: "${auditQuote}"`);
          return { content, isError };
        }
        const target = address.toLowerCase();
        if (existing.some(s => s.address.toLowerCase() === target)) {
          content = `${name} (${address}) is already on the iMessage safe-sender list. No change.`;
          isError = false;
          auditLog(agentId, 'add_safe_sender', `imessage:${address}`, 'success', `already on list; quote: "${auditQuote}"`);
          return { content, isError };
        }
        // Always a non-owner entry (is_primary false); the owner record is never touched.
        const next = [...existing, sender];
        db.prepare(`
          INSERT INTO config (key, value, updated_at) VALUES ('imessage_approved_senders', ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
        `).run(JSON.stringify(next));
        try { reloadApprovedSenders(); } catch { /* bridge may not be running */ }
        // Mirror into contacts so the trusted name resolves later (best-effort).
        try {
          syncSafeSenderToContacts('imessage', sender, agentId);
        } catch { /* contacts mirror is best-effort */ }
        content =
          `Added ${name} (${address}) to the iMessage safe-sender list (sharing level: ${sharingLevel}). ` +
          `Future iMessages from this address will auto-route a reply when you respond. ` +
          `${next.length} safe sender(s) total.`;
        isError = false;
        auditLog(agentId, 'add_safe_sender', `imessage:${address}`, 'success', `level=${sharingLevel}; quote: "${auditQuote}"`);
      } else if (channelArg === 'teams') {
        // Teams: single shared list (no slot today).
        const result = appendTeamsSafeSender(sender);
        if (!result.added) {
          content = `${name} (${address}) is already on the Teams safe-sender list. No change.`;
          isError = false;
          auditLog(agentId, 'add_safe_sender', `teams:${address}`, 'success', `already on list; quote: "${auditQuote}"`);
          return { content, isError };
        }
        content =
          `Added ${name} (${address}) to the Teams safe-sender list (sharing level: ${sharingLevel}). ` +
          `The engine will auto-route their next Teams DM back to them when you respond. ` +
          `${result.totalSenders} safe sender(s) total.`;
        isError = false;
        auditLog(agentId, 'add_safe_sender', `teams:${address}`, 'success', `level=${sharingLevel}; quote: "${auditQuote}"`);
      } else {
        // gmail / outlook are per-slot: require the slot arg and that the slot can
        // send, since a safe sender on a send-disabled slot could never auto-reply.
        const slot = args.slot as string | undefined;
        if (slot !== 'agent' && slot !== 'user') {
          content = `Error: \`slot\` is required for ${channelArg} (must be "agent" or "user"). The slot identifies which mailbox\'s list to add to, the agent\'s own ${channelArg} account or the user\'s personal ${channelArg} account.`;
          isError = true;
          auditLog(agentId, 'add_safe_sender', `${channelArg}:${address}`, 'error', `missing slot arg; quote: "${auditQuote}"`);
          return { content, isError };
        }
        // The slot's first mailbox: its sending switch, its address for the messages below, and its id for the list.
        const sendingEnabled = channelArg === 'gmail' ? isEmailSendingEnabled(slot) : isMsEmailSendingEnabled(slot);
        const account = channelArg === 'gmail' ? getPrimaryGoogleAccount(slot) : getPrimaryMicrosoftAccount(slot);
        const accountEmail = account?.email ?? null;
        if (!sendingEnabled) {
          const acctLabel = accountEmail ? `${accountEmail} (the ${slot} slot)` : `the ${slot} slot`;
          const channelLabel = channelArg === 'gmail' ? 'Gmail' : 'Outlook';
          content =
            `Refused: ${acctLabel} has "The agent may send as me" turned OFF on the ${channelLabel} integration. ` +
            `Safe senders are only useful on a slot that can actually auto-reply, so adding them here would be misleading. ` +
            `Tell ${userWords(currentAddress(agentId))} that the owner needs to open Settings → Channels and toggle "The agent may send as me" ON for ${acctLabel}, then retry. ` +
            `Don't try this call again until they confirm they've turned it on.`;
          isError = true;
          auditLog(agentId, 'add_safe_sender', `${channelArg}:${address}`, 'denied', `slot=${slot} sendEmail=off; quote: "${auditQuote}"`);
          return { content, isError };
        }
        const result = appendMailSafeSender(channelArg as 'gmail' | 'outlook', account?.id ?? slot, sender);
        const channelHumanLabel = channelArg === 'gmail' ? 'Gmail' : 'Outlook';
        const slotLabel = accountEmail ? `${accountEmail} (${slot} slot)` : `${slot} slot`;
        if (!result.added) {
          content = `${name} (${address}) is already on the ${channelHumanLabel} safe-sender list for ${slotLabel}. No change.`;
          isError = false;
          auditLog(agentId, 'add_safe_sender', `${channelArg}/${slot}:${address}`, 'success', `already on list; quote: "${auditQuote}"`);
          return { content, isError };
        }
        content =
          `Added ${name} (${address}) to the ${channelHumanLabel} safe-sender list for ${slotLabel} ` +
          `(sharing level: ${sharingLevel}). When they reply on this mailbox, the engine will auto-route ` +
          `your response back. ${result.totalSenders} safe sender(s) total on this slot.`;
        isError = false;
        auditLog(agentId, 'add_safe_sender', `${channelArg}/${slot}:${address}`, 'success', `level=${sharingLevel}; quote: "${auditQuote}"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      content = `Error adding safe sender: ${msg}`;
      isError = true;
      auditLog(agentId, 'add_safe_sender', `${channelArg}:${address}`, 'error', msg);
    }
    return { content, isError };
  },

  async "imessage_list_contacts"({ agentId }) {
    let content = '';
    let isError = false;
    const all = getSafeSenders();
    if (all.length === 0) {
      content = `No iMessage safe senders are configured on this server. Tell ${userWords(currentAddress(agentId))} that the owner can add contacts in Settings → Channels → iMessage Bridge if they want you to text someone.`;
      isError = false;
      return { content, isError };
    }
    const lines = all.map(s => {
      const role = s.is_primary ? 'PRIMARY USER' : `sharing: ${s.sharing_level}`;
      const desc = s.description ? ` - ${s.description}` : '';
      return `  - ${s.name} <${s.address}>${desc} [${role}]`;
    });
    content =
      `${all.length} safe sender(s) configured:\n${lines.join('\n')}\n\n` +
      `Pick the contact that best matches what the person you are talking to said. To iMessage them, ` +
      `call imessage_send with recipient="<address>" (the angle-bracketed value above). ` +
      `If two or more contacts plausibly fit, ask ${userWords(currentAddress(agentId))} which one they meant before sending. ` +
      `Honor each contact's sharing_level when deciding what to share.`;
    isError = false;
    return { content, isError };
  },

  async "imessage_send"({ agentId, args }) {
    let content = '';
    let isError = false;
    let recipient = args.recipient as string | undefined;
    const message = args.message as string;
    const attachmentPaths = Array.isArray(args.attachments)
      ? (args.attachments as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : [];


    // Recipient resolution is two-stage: find the intended recipient, then confirm
    // it is on the safe-sender allowlist, so the model cannot text a number it invented.
    const safeRecords = getSafeSenders();
    if (safeRecords.length === 0) {
      content = 'iMessage was NOT sent - no safe senders are configured on this server. Add one in Settings → Channels → iMessage Bridge, then try again.';
      isError = true;
      auditLog(agentId, 'imessage_send', recipient ?? '(no recipient)', 'error', 'no safe senders');
      return { content, isError };
    }

    // A send with no recipient NEVER falls back to this turn's counterparty (a wrong
    // fallback sends owner-meant words to a contact). The executor refuses first; this
    // guard keeps a direct call honest and names the turn addressee so the agent picks
    // the person knowingly.
    if (!recipient) {
      const refused = refuseSendWithNoRecipient(agentId, 'imessage_send', args, '');
      auditLog(agentId, 'imessage_send', '(no recipient)', 'error', 'no recipient named');
      return { content: refused?.content ?? 'iMessage NOT sent - name the recipient.', isError: true };
    } else {
      const match = findSafeSenderByAddress(safeRecords, recipient);
      if (!match) {
        const valid = safeRecords
          .map(s => `${s.name} <${s.address}>`)
          .join(', ');
        content =
          `iMessage NOT sent - recipient "${recipient}" is not on the safe-sender allowlist. ` +
          `Valid recipients on this server: ${valid}. ` +
          `If you meant to reply to the person who just messaged you, just write your reply: the engine delivers it. To text someone, name them in recipient. ` +
          `If you need to text someone new, the owner has to add them in Settings → Channels → iMessage Bridge first.`;
        isError = true;
        auditLog(agentId, 'imessage_send', recipient, 'denied', 'recipient not in allowlist');
        return { content, isError };
      }
      recipient = match.address; // canonicalize formatting
    }

    const recipientRecord = findSafeSenderByAddress(safeRecords, recipient);

    // The me-vs-others tier (mayReachOthersOn) sits here, not at a declared gate,
    // because the question needs the RESOLVED recipient: the executor's gate loop
    // runs before dispatch with only `args`, where the recipient may be absent or
    // an un-canonicalized alias. The owner is `is_primary` on the safe-sender list,
    // the same flag the bridge's owner-bound redirect reads; an unresolvable record
    // counts as NOT the owner, so the unknown case stays narrow.
    if (!mayReachOthersOn(agentId, 'imessage') && recipientRecord?.is_primary !== true) {
      const ownerRecord = safeRecords.find((s) => s.is_primary);
      content =
        `Permission denied: this agent may only iMessage ${ownerRecord?.name ?? 'the owner'}, `
        + `and "${recipientRecord?.name ?? recipient}" is someone else. The message was NOT sent. `
        + 'Ask the primary agent to widen this agent\'s iMessage grant to "anyone approved" if this needs to happen.';
      isError = true;
      auditLog(agentId, 'imessage_send', recipient, 'denied', 'channel tier is owner-only; recipient is not the owner');
      return { content, isError, errorCode: 'PERMISSION_DENIED' as ToolErrorCode };
    }

    // The transport check MUST come after the permission checks: a dead bridge would
    // answer "transport down" to a request that was never allowed, masking the permission.
    // Fail loudly when the bridge is OFF: never let the agent claim delivery that failed.
    // The fallback alternative is READ from live config at the moment of refusal; never
    // prescribe the dashboard chat while SMS is live and approved on the same box.
    const bridgeStatus = getIMBridgeStatus();
    if (!bridgeStatus.running) {
      const sms = getSmsReachability();
      // On a routed turn the written reply goes to that person on their own channel.
      const route = routedReplyWords(agentId);
      content =
        'iMessage bridge is currently disabled, so this message was NOT sent. ' +
        (sms.live
          ? `SMS IS live on this server (approved: ${describeSmsRecipients(sms)}) — send it with `
            + (route ? `sms_send instead. If that fails too, ${route.where}. ` : 'sms_send instead. Only if that fails too should you tell the user and answer in '
            + 'the dashboard chat. ')
          : (route ? `${route.down} ` : 'Tell the user that iMessage is turned off on this server and respond to them in the dashboard chat instead. ')) +
        (bridgeStatus.enabled
          ? 'To re-enable iMessage delivery, the user can start it from Settings → Channels → iMessage Bridge.'
          : 'The user can enable iMessage by adding an approved sender in Settings → Channels → iMessage Bridge.');
      isError = true;
      auditLog(agentId, 'imessage_send', recipient ?? '(no recipient)', 'denied', 'bridge disabled');
      return { content, isError };
    }

    // No channel-context guard by design: the engine must not second-guess an explicit
    // imessage_send. The default-channel hint is a HARD RULE in the tool description.

    // Pre-flight: fail fast on any missing file before bytes go over the wire;
    // a partial send leaves the recipient a fragment the agent can't account for.
    if (attachmentPaths.length > 0) {
      for (const p of attachmentPaths) {
        if (!p.startsWith('/')) {
          content = `iMessage NOT sent - attachment path "${p}" must be absolute (start with /). Use the full local path.`;
          isError = true;
          auditLog(agentId, 'imessage_send', recipient, 'error', 'relative attachment path');
          break;
        }
        if (!effectFs.existsSync(p)) {
          content = `iMessage NOT sent - attachment file not found at "${p}". Verify the path or re-create the file.`;
          isError = true;
          auditLog(agentId, 'imessage_send', recipient, 'error', `missing attachment: ${p}`);
          break;
        }
        try {
          const stat = effectFs.statSync(p);
          if (!stat.isFile()) {
            content = `iMessage NOT sent - attachment "${p}" is not a regular file (is it a directory?).`;
            isError = true;
            auditLog(agentId, 'imessage_send', recipient, 'error', `non-file attachment: ${p}`);
            break;
          }
          if (stat.size > MAX_IMESSAGE_FILE_BYTES) {
            const mb = (stat.size / 1024 / 1024).toFixed(1);
            content = `iMessage NOT sent - attachment "${p}" is ${mb}MB, which exceeds iMessage's ~100MB per-file limit. Use share_publicly or upload to a cloud drive and send the link instead.`;
            isError = true;
            auditLog(agentId, 'imessage_send', recipient, 'error', `attachment too large: ${p} ${mb}MB`);
            break;
          }
        } catch (err) {
          content = `iMessage NOT sent - cannot stat attachment "${p}": ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
          auditLog(agentId, 'imessage_send', recipient, 'error', `stat error: ${p}`);
          break;
        }
      }
      if (isError) return { content, isError };
    }

    // The agent's own send, bound to its Stop.
    const result = await sendIMessageWithAttachments(recipient, message, attachmentPaths, { agentId });
    if (!result.ok && result.sentFiles.length === 0 && !result.textSent) {
      const route = routedReplyWords(agentId);
      content =
        'iMessage NOT sent - nothing went out. Either neither the imsg CLI nor AppleScript could deliver it, or the owner pressed Stop. ' +
        (route ? `${route.failed} ` : 'Tell the user the message did not go through, and respond in the dashboard chat instead. ') +
        'The user can check System Settings - Privacy & Security - Automation to grant Messages access if AppleScript is the issue.';
      isError = true;
      auditLog(agentId, 'imessage_send', recipient, 'error', 'send returned false');
      return { content, isError };
    }

    // Double-send prevention is turn-state: the executor records this send and the
    // end-of-turn auto-route checks it, so an explicit reply suppresses the engine's.


    // Loud recipient-switch note: an inbound-from-A, send-to-B switch must show in the log.
    const recipientLabel = recipientRecord
      ? `${recipientRecord.name} (${recipientRecord.address})`
      : recipient;
    // "0/N attachment(s)" reads as a successful send, so say plainly when files did not
    // go; mirror case, files sent but text lost, must not read as a clean whole-message send.
    const wordsLost = message.trim() !== '' && result.textSent === false && result.sentFiles.length > 0;
    const attachSummary = attachmentPaths.length > 0
      ? result.sentFiles.length === 0
        ? ` as text only - NONE of the ${attachmentPaths.length} attachment(s) went out${result.failedFiles.length > 0 ? ` (failed: ${result.failedFiles.join(', ')})` : ''}. Tell the recipient the files did not arrive, or try again`
        : ` with ${result.sentFiles.length}/${attachmentPaths.length} attachment(s)${result.failedFiles.length > 0 ? ` (failed: ${result.failedFiles.join(', ')})` : ''}${wordsLost ? ' - the file(s) went out but your message text did NOT arrive. Tell the recipient or send the words again' : ''}`
      : '';
    // Audit captures the sharing context (level, reply vs switch) for later review.
    const auditDetailParts: string[] = [
      `Sent ${message.length} chars`,
    ];
    if (attachmentPaths.length > 0) {
      auditDetailParts.push(`+ ${result.sentFiles.length}/${attachmentPaths.length} attachments`);
    }
    if (wordsLost) {
      auditDetailParts.push('words not delivered');
    }
    if (recipientRecord) {
      auditDetailParts.push(`recipientLevel=${recipientRecord.sharing_level}`);
    }
    // The executor adds the recipient note to the tool result, for every channel.
    auditDetailParts.push(turnContext(agentId)?.address?.kind === 'person' ? 'turn-has-addressee' : 'proactive');
    auditLog(agentId, 'imessage_send', recipient, 'success', auditDetailParts.join(' | '));
    // iMessage is unverifiable (no provider id exists): write a tier-3 exit-code receipt
    // so nothing pretends delivery was confirmed. skipAudit: the rich audit row above is it.
    writeToolReceipt({ agentId, tool: 'imessage_send', tier: 3, verified: false, basis: 'exit-code', recipient, sentText: message, detail: { textSent: result.textSent, attachmentsSent: result.sentFiles.length }, skipAudit: true });
    content = `iMessage sent to ${recipientLabel}${attachSummary}.`;
    return { content, isError };
  },

  async "share_publicly"({ agentId, args }) {
    let content = '';
    let isError = false;
    const sourcePath = (args.source_path as string | undefined)?.trim();
    const entryFilename = (args.entry_filename as string | undefined)?.trim() || undefined;
    if (!sourcePath) {
      content = 'Error: source_path is required.';
      isError = true;
      return { content, isError };
    }
    // share_publicly mints an unauthenticated URL, so guard the path before publishing.
    const publishGuard = await sharePathGuard(agentId, 'share_publicly', sourcePath);
    if (!publishGuard.allowed) {
      auditLog(agentId, 'share_publicly', publishGuard.absPath, 'denied', publishGuard.reason);
      content = publishGuard.blockedMessage ?? permissionDeniedMessage(publishGuard.reason, agentId);
      isError = true;
      return { content, isError };
    }
    try {
      // Publish the guard-approved absPath (the guard expanded `~`; createPublicShare
      // only accepts absolutes), never the raw source_path.
      const result = createPublicShare({ sourcePath: publishGuard.absPath, entryFilename });
      auditLog(agentId, 'share_publicly', publishGuard.absPath, 'success', `Slug ${result.slug}, base ${result.baseSource}`);
      const tunnelLine = linkReach(result.url);
      let assetLine = '';
      if (result.inlinedAssets) {
        const { copied, skipped, notFound, warnings } = result.inlinedAssets;
        const total = copied + skipped + notFound;
        if (total > 0) {
          const parts: string[] = [`${copied} copied`];
          if (skipped > 0) parts.push(`${skipped} skipped`);
          if (notFound > 0) parts.push(`${notFound} missing on disk`);
          assetLine = `\n\nLinked assets: ${parts.join(', ')}.`;
          if (notFound > 0) {
            assetLine += ` Pages with missing images will render with broken thumbnails, re-check that the source HTML's references point at files that actually exist before re-sharing.`;
          }
          if (warnings.length > 0) {
            const shown = warnings.slice(0, 5);
            assetLine += `\nWarnings:\n  - ${shown.join('\n  - ')}`;
            if (warnings.length > shown.length) {
              assetLine += `\n  - …and ${warnings.length - shown.length} more`;
            }
          }
        }
      }
      content = `Public URL: ${result.url}\n\n${tunnelLine}${assetLine}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog(agentId, 'share_publicly', publishGuard.absPath, 'error', msg);
      content = `Error sharing file: ${msg}`;
      isError = true;
    }
    return { content, isError };
  },

  async "sms_send"({ agentId, args }) {
    let content = '';
    let isError = false;
    if (!mayUseChannel(agentId, 'sms')) {
      content = 'Permission denied: only the primary agent can use sms_send.';
      isError = true;
      auditLog(agentId, 'sms_send', null, 'denied', 'sms_send restricted to primary agent');
      return { content, isError };
    }
    const result = await executeSmsSend({
      to: args.to as string,
      body: args.body as string,
      from: args.from as string | undefined,
    }, agentId);
    content = result.message;
    isError = !result.ok;
    // Mark explicit sms send so the auto-route at end-of-turn
    // doesn't ALSO send the agent's terminal text.
    if (result.ok) {
      // The receipt writer emits the single provenance audit row (SID as provider id),
      // so don't double-write an audit row here. A 2xx with no SID cannot be confirmed.
      if (!result.sid) {
        writeToolReceipt({ agentId, tool: 'sms_send', tier: 1, verified: false, basis: 'http-status', recipient: args.to as string, sentText: args.body as string, detail: { anomaly: 'sms send ok but no Twilio SID' } });
        content = `Error: the SMS to ${args.to} was accepted but Twilio returned no message SID, so it could not be verified. It may still have been delivered: verify whether it went out (check the thread/recipient) BEFORE any re-send; do not blindly retry.`;
        isError = true;
      } else {
        writeToolReceipt({ agentId, tool: 'sms_send', tier: 1, verified: true, basis: 'provider-id', providerId: result.sid, recipient: args.to as string, sentText: args.body as string, detail: { status: 'sent' } });
      }
    } else {
      auditLog(agentId, 'sms_send', args.to as string, 'error', result.message.slice(0, 200));
    }
    return { content, isError };
  },

  async "voice_call"({ agentId, args }) {
    let content = '';
    let isError = false;
    if (!mayUseChannel(agentId, 'voice')) {
      content = 'Permission denied: only the primary agent can use voice_call.';
      isError = true;
      auditLog(agentId, 'voice_call', null, 'denied', 'voice_call restricted to primary agent');
      return { content, isError };
    }
    const { executeVoiceCall } = await import('../../../twilio/voice-outbound.js');
    const result = await executeVoiceCall({
      to: args.to as string,
      opening_message: args.opening_message as string | undefined,
      purpose: args.purpose as string | undefined,
      from: args.from as string | undefined, agentId, // so the owner's Stop can abort it
    });
    content = result.message;
    isError = !result.ok;
    if (result.ok) {
      // The receipt row is the audit row; no call SID means unverifiable, so fail.
      if (!result.callSid) {
        writeToolReceipt({ agentId, tool: 'voice_call', tier: 1, verified: false, basis: 'http-status', recipient: args.to as string, detail: { anomaly: 'voice call ok but no Twilio call SID' } });
        content = `Error: the call to ${args.to} was accepted but Twilio returned no call SID, so it could not be verified. The call may still have been placed: verify it did not go through BEFORE dialing again; do not blindly retry.`;
        isError = true;
      } else {
        writeToolReceipt({ agentId, tool: 'voice_call', tier: 1, verified: true, basis: 'provider-id', providerId: result.callSid, recipient: args.to as string, detail: { status: 'placed' } });
      }
    } else {
      auditLog(agentId, 'voice_call', args.to as string, 'error', result.callSid ?? '(no sid)');
    }
    return { content, isError };
  },

  async "voice_call_end"({ agentId, args }) {
    let content = '';
    let isError = false;
    if (!mayUseChannel(agentId, 'voice')) {
      content = 'Permission denied: only the primary agent can use voice_call_end.';
      isError = true;
      return { content, isError };
    }
    const { executeVoiceCallEnd } = await import('../../../twilio/voice-outbound.js');
    const r = executeVoiceCallEnd({ call_id: args.call_id as string, reason: args.reason as string | undefined });
    content = r.message;
    isError = !r.ok;
    return { content, isError };
  },

  async "voice_call_status"({ agentId, args }) {
    let content = '';
    let isError = false;
    if (!mayUseChannel(agentId, 'voice')) {
      content = 'Permission denied: only the primary agent can use voice_call_status.';
      isError = true;
      return { content, isError };
    }
    const { executeVoiceCallStatus } = await import('../../../twilio/voice-outbound.js');
    const r = executeVoiceCallStatus({ call_id: args.call_id as string | undefined });
    content = r.message;
    isError = false;
    return { content, isError };
  },

};
