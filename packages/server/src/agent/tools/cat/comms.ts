// ════════════════════════════════════════════════════════════════════════════
// COMMUNICATION (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// Everything that reaches a PERSON: the chat attachment surface
// (`show_to_user`), the two file-publishing verbs (`share_file`,
// `share_publicly`), iMessage (`imessage_send`, `imessage_list_contacts`,
// `add_safe_sender`), SMS (`sms_send`) and the three voice-call verbs.
//
// RELOCATION, NOT REWRITE. Every body is the body that stood in the switch,
// byte for byte; the only edit a move requires is that `content = …; break;`
// became `return { content, isError }`, so the executor's tail (the per-tool
// `maxResultTokens` cap, the unknown-args warning, the crash-to-message catch,
// the audit row) still applies to every one of them identically.
//
// ── THE HANDLER-BODY `checkPermission` THAT MOVED WITH ITS HANDLER ──
// `show_to_user` calls `checkPermission(agentId, { type: 'file_read', … })` on
// every path it is asked to show. That is one of the exactly TWO permission
// checks §T0-PINS P6 found buried inside handler bodies rather than declared as
// gates, and T7's demolition list owns it BY NAME. It is preserved here
// verbatim: a relocation that dropped it would remove a live protection, and
// converting it into a declared gate is a change of mechanism, which is T7's
// call and not a move's. The same is true of `share_file`/`share_publicly`'s
// `sharePathGuard` calls — the broker T2 installed, called from the body.
//
// ── WHAT DID *NOT* MOVE ──
// `imessage_send`'s primary-only wall and `sms_send`'s gates are DECLARED gates
// evaluated by T2's gate loop in the executor, ahead of dispatch. They were
// never in these bodies, so this move cannot take them with it — which is the
// point of the registry and the loop.
//
// ── TEN LAZY LOADS DIED; THE THREE `voice-outbound` ONES STAYED, MEASURED ──
// RULING P5-R9: an unsanctioned `await import(…)` in the toolbox dies UNLESS it
// defers a module-load side effect, and the unit suite is the arbiter. Ten were
// converted (none of their targets imports anything from the toolbox, so none
// broke a cycle). The three `twilio/voice-outbound.js` loads were converted
// too, and the suite went RED: that module statically imports
// `twilio/call-session.ts`, whose module TOP LEVEL runs `void getOwnerName;`
// (`call-session.ts:882-884`, a deliberate unused-import suppression), so a
// static import pulls that read of `config/platform.js` into the toolbox's
// graph ahead of the partial `vi.mock` in `spawn-contract.test.ts` and
// `squad-coordination.test.ts` — `No "getOwnerName" export is defined on the
// "../../config/platform.js" mock`. Reverted WITH the measurement rather than
// by editing the mock. This is the second member of P5-R9's class and it is a
// different module from the first (`services/agent-controls.js`).
// ════════════════════════════════════════════════════════════════════════════

import * as effectFs from '../../effects/fs.js';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { ToolErrorCode } from '@dojo/shared';
import { getDb } from '../../../db/connection.js';
import { isPrimaryAgent } from '../../../config/platform.js';
import { writeToolReceipt } from '../../../receipts/store.js';
import { checkPermission } from '../../permissions.js';
import { sharePathGuard } from '../../path-guards.js';
import { auditLog, permissionDeniedMessage, registerSharedFile } from '../util.js';
import os from 'node:os';
import { appendTeamsSafeSender, appendGmailSafeSender, appendOutlookSafeSender } from '../../../services/channel-safe-senders.js';
import { createPublicShare } from '../../../services/public-share.js';
import { executeSmsSend } from '../../../twilio/sms-outbound.js';
import { isEmailSendingEnabled, getGoogleWorkspaceConfig } from '../../../google/auth.js';
import { isMsEmailSendingEnabled, getMicrosoftWorkspaceConfig } from '../../../microsoft/auth.js';
import { parseSafeSenders, reloadApprovedSenders, getSafeSenders, getIMBridgeStatus, findSafeSenderByAddress, getTurnScopedImRecipient, sendIMessageWithAttachments } from '../../../services/imessage-bridge.js';
import { getSmsReachability, describeSmsRecipients } from '../../../services/capability-registry.js';
import { queuePendingAttachments } from '../../pending-attachments.js';
import { syncSafeSenderToContacts } from '../../../contacts/from-safe-senders.js';
import type { ToolHandlerMap } from '../handler.js';

export const commsHandlers: ToolHandlerMap = {
  async "share_file"({ agentId, args }) {
    let content = '';
    let isError = false;
    let errorCode: ToolErrorCode | undefined;
    // T10: minting a public URL is a read that leaves the box. Same
    // sensitive-path list and file_read permission every read tool uses.
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
    content = `Download link for ${filename}: ${downloadUrl}`;
    auditLog(agentId, 'share_file', sharePath, 'success', downloadUrl);
    return { content, isError, ...(errorCode !== undefined ? { errorCode } : {}) };
  },

  async "show_to_user"({ agentId, args }) {
    let content = '';
    let isError = false;
    const filePaths = args.file_paths as string[] | undefined;
    const caption = (args.caption as string | undefined) ?? '';
    // v2.9.20: caption is now captured alongside the queued
    // attachments. If the model writes terminal text after this
    // call (the documented happy path), that text becomes the
    // bubble caption and this one is ignored. If the model
    // finishes the turn WITHOUT writing terminal text (the
    // failure mode that lost JJ's report in the 2026-06-06
    // incident), the engine's end-of-turn safety net surfaces
    // the captured caption as the bubble text so the files
    // don't vanish silently.
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

    const uploadsDir = path.join(os.homedir(), '.dojo', 'uploads', agentId);
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
        // Permission check, agents can only show files they're allowed to read.
        const allowed = checkPermission(agentId, { type: 'file_read', path: srcPath });
        if (!allowed.allowed) {
          content = `Error: not allowed to read ${srcPath} (${allowed.reason ?? 'permission denied'}). show_to_user respects file_read permissions.`;
          isError = true;
          break;
        }
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

        // show_to_user is for IMAGES (and short audio/video clips) shown
        // inline in the chat. DOCUMENTS, PDF, Word/Excel/PowerPoint,
        // Markdown/text/code, belong in the CANVAS, where they render as a
        // real formatted preview instead of a dead download chip. The two
        // surfaces are routinely confused by weaker models; reject documents
        // here and point at the canvas so the agent can't pick the wrong one.
        if (category === 'pdf' || category === 'text' || category === 'office' || category === 'unknown') {
          content = `Error: "${filename}" is a document, not an image, show_to_user is for images (and short audio/video clips) shown inline in the chat. Documents render in the CANVAS: a canvas-renderable file auto-opens the moment you write it (file_write, or creating a Word/Excel/PDF), or call canvas_render({ path: "${srcPath}" }) to (re)open it. Using show_to_user here would give the user a useless download chip instead of a readable preview.`;
          isError = true;
          break;
        }

        // If file is already in this agent's uploads dir, use it directly.
        // Otherwise copy in so the dashboard's /api/upload/file/<agentId>/<name>
        // serve route can find it.
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

    // Queue the attachments for the agent's NEXT assistant message rather
    // than inserting a synthetic message here. Inserting mid-tool-loop
    // broke the alternation invariant and confused the model into
    // re-calling show_to_user repeatedly. The runtime drains this queue
    // when it persists the agent's next assistant write, the user sees
    // a single bubble with the agent's text reply AND the thumbnails.
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
    const userRequestQuote = (args.user_request_quote as string | undefined)?.trim() ?? '';
    if (!channelArg || !addressArg) {
      content = 'Error: both `channel` and `address` are required.';
      isError = true;
      return { content, isError };
    }
    if (!userRequestQuote) {
      content = 'Error: `user_request_quote` is required. Quote the user\'s actual words asking you to start this conversation. If you cannot quote a real user request, do NOT call this tool.';
      isError = true;
      return { content, isError };
    }
    // Minimum length guard, a one-word "ok" isn't a request to add a
    // sender. Forces the agent to commit to specific evidence.
    if (userRequestQuote.length < 8) {
      content = 'Error: `user_request_quote` is too short to be a real user request. Quote the full sentence where the user asked you to start this conversation.';
      isError = true;
      return { content, isError };
    }
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
    // Truncate the quote for the audit log so a giant paste doesn't
    // flood the log row; full quote stays in the tool-call args for
    // forensic review.
    const auditQuote = userRequestQuote.length > 200
      ? userRequestQuote.slice(0, 200) + '…'
      : userRequestQuote;

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
        // iMessage list lives in its own config key with a bridge cache.
        // Read, dedup, write, then hot-reload the bridge so it picks up
        // the new sender immediately (matches the Settings.tsx flow).
        const db = getDb();
        const row = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
        const existing = parseSafeSenders(row?.value ?? null);
        const target = address.toLowerCase();
        if (existing.some(s => s.address.toLowerCase() === target)) {
          content = `${name} (${address}) is already on the iMessage safe-sender list. No change.`;
          isError = false;
          auditLog(agentId, 'add_safe_sender', `imessage:${address}`, 'success', `already on list; quote: "${auditQuote}"`);
          return { content, isError };
        }
        // Preserve at least one primary record (first entry stars by default).
        const next = [...existing, sender];
        if (!next.some(s => s.is_primary) && next.length > 0) {
          next[0].is_primary = true;
        }
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
        // gmail / outlook, per-slot. Require the slot arg AND verify
        // the slot has "Allow sending email" enabled before adding.
        // Adding a safe sender to a slot whose sending is disabled would
        // be useless (auto-reply wouldn't fire) and confusing.
        const slot = args.slot as string | undefined;
        if (slot !== 'agent' && slot !== 'user') {
          content = `Error: \`slot\` is required for ${channelArg} (must be "agent" or "user"). The slot identifies which mailbox\'s list to add to, the agent\'s own ${channelArg} account or the user\'s personal ${channelArg} account.`;
          isError = true;
          auditLog(agentId, 'add_safe_sender', `${channelArg}:${address}`, 'error', `missing slot arg; quote: "${auditQuote}"`);
          return { content, isError };
        }
        // Check sending capability on the target slot. Also read the
        // account email so error/success messages can name the actual
        // mailbox (e.g., "user@example.com (user slot)") rather than
        // just "user slot" which is opaque. Both providers read through
        // their table-backed config getters (Path B).
        let sendingEnabled = false;
        let accountEmail: string | null = null;
        if (channelArg === 'gmail') {
          sendingEnabled = isEmailSendingEnabled(slot);
          accountEmail = getGoogleWorkspaceConfig(slot).accountEmail;
        } else { // outlook
          sendingEnabled = isMsEmailSendingEnabled(slot);
          accountEmail = getMicrosoftWorkspaceConfig(slot).accountEmail;
        }
        if (!sendingEnabled) {
          const acctLabel = accountEmail ? `${accountEmail} (the ${slot} slot)` : `the ${slot} slot`;
          const channelLabel = channelArg === 'gmail' ? 'Gmail' : 'Outlook';
          content =
            `Refused: ${acctLabel} has "Allow sending email" turned OFF on the ${channelLabel} integration. ` +
            `Safe senders are only useful on a slot that can actually auto-reply, so adding them here would be misleading. ` +
            `Tell the user they need to open Settings → Channels and toggle "Allow sending email" ON for ${acctLabel}, then retry. ` +
            `Don't try this call again until they confirm they've turned it on.`;
          isError = true;
          auditLog(agentId, 'add_safe_sender', `${channelArg}:${address}`, 'denied', `slot=${slot} sendEmail=off; quote: "${auditQuote}"`);
          return { content, isError };
        }
        // OK to add.
        const result = channelArg === 'gmail'
          ? appendGmailSafeSender(slot, sender)
          : appendOutlookSafeSender(slot, sender);
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

  async "imessage_list_contacts"() {
    let content = '';
    let isError = false;
    const all = getSafeSenders();
    if (all.length === 0) {
      content = 'No iMessage safe senders are configured on this server. Tell the user to add contacts in Settings → Channels (iMessage card) if they want you to text someone.';
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
      `Pick the contact that best matches what the user said. To iMessage them, ` +
      `call imessage_send with recipient="<address>" (the angle-bracketed value above). ` +
      `If two or more contacts plausibly fit, ask the user which one they meant before sending. ` +
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

    // v2.3.19 - fail loudly when the iMessage bridge is OFF. Pre-spec
    // the tool returned "iMessage sent to X" regardless of bridge
    // state, which left the agent confidently claiming delivery to
    // the user when nothing was actually sent. Now the agent gets a
    // clear error so it can tell the user the bridge is disabled
    // and use the dashboard chat instead.
    // UX-REPAIR ROUND 7 T29 — the door was right about iMessage and wrong about the
    // alternative. Round-7 S3: it prescribed the dashboard while SMS was enabled and approved
    // on the same box, and the user's text was never sent on any channel. The alternative is
    // now READ from live config at the moment of refusal; when nothing else is live the
    // sentence below is the one that has always been here, byte for byte.
    const bridgeStatus = getIMBridgeStatus();
    if (!bridgeStatus.running) {
      const sms = getSmsReachability();
      content =
        'iMessage bridge is currently disabled, so this message was NOT sent. ' +
        (sms.live
          ? `SMS IS live on this server (approved: ${describeSmsRecipients(sms)}) — send it with `
            + 'sms_send instead. Only if that fails too should you tell the user and answer in '
            + 'the dashboard chat. '
          : 'Tell the user that iMessage is turned off on this server and respond to them in the dashboard chat instead. ') +
        (bridgeStatus.enabled
          ? 'To re-enable iMessage delivery, the user can start it from Settings → Channels (iMessage card).'
          : 'The user can enable iMessage by adding an approved sender in Settings → Channels (iMessage card).');
      isError = true;
      auditLog(agentId, 'imessage_send', recipient ?? '(no recipient)', 'denied', 'bridge disabled');
      return { content, isError };
    }

    // ── Recipient resolution + allowlist gate ────────────────────
    // Two-stage. First, figure out the intended recipient (explicit
    // arg, else inbound-trigger sender, else starred primary). Then
    // confirm that recipient is in the safe-sender allowlist - this
    // prevents the model from sending to a number it invented or
    // copied from a different conversation context.
    const safeRecords = getSafeSenders();
    if (safeRecords.length === 0) {
      content = 'iMessage was NOT sent - no safe senders are configured on this server. Add one in Settings → Channels (iMessage card), then try again.';
      isError = true;
      auditLog(agentId, 'imessage_send', recipient ?? '(no recipient)', 'error', 'no safe senders');
      return { content, isError };
    }

    // FA-C1: the omitted-recipient default resolves from the TURN-scoped
    // iMessage counterparty ONLY. The stripped legacy last-inbound map
    // (P5c) held whoever texted this agent most
    // recently at INGEST time, decoupled from turn execution, so on a
    // proactive/scheduled turn, or the owner on the dashboard saying "text me
    // X", it could deliver the owner's message to a contact who happened to
    // text moments earlier (third-party delivery of owner-directed content).
    // A genuine iMessage-reply turn always publishes its counterparty to
    // its `TurnContext`, so turn-scoped resolution keeps every real reply
    // working while refusing to guess on a proactive send.
    const inboundSender = getTurnScopedImRecipient(agentId);
    let switchedFromInbound: string | null = null;

    if (!recipient) {
      // No explicit recipient. If this turn is replying to an inbound
      // iMessage, default to the actual sender of that inbound.
      if (inboundSender) {
        const match = findSafeSenderByAddress(safeRecords, inboundSender);
        recipient = match?.address ?? inboundSender;
      } else {
        // No explicit recipient AND this turn is not replying to an inbound
        // iMessage (proactive / scheduled / dashboard-initiated). There is no
        // one to safely default to, so do NOT guess: make the model name a
        // recipient explicitly.
        const valid = safeRecords
          .map(s => `${s.name} <${s.address}>`)
          .join(', ');
        content =
          `iMessage NOT sent - no recipient was specified and this turn is not replying to an inbound iMessage, ` +
          `so there is no one to default to. Re-call imessage_send with an explicit recipient: pass ` +
          `recipient="+1XXXXXXXXXX" (the full number in +country-code form) or recipient="<contact name>" ` +
          `exactly as it appears in Settings → Channels (iMessage card). ` +
          `Valid recipients on this server: ${valid}.`;
        isError = true;
        auditLog(agentId, 'imessage_send', '(no recipient)', 'error', 'no recipient and no turn-scoped inbound sender');
        return { content, isError };
      }
    } else {
      const match = findSafeSenderByAddress(safeRecords, recipient);
      if (!match) {
        const valid = safeRecords
          .map(s => `${s.name} <${s.address}>`)
          .join(', ');
        content =
          `iMessage NOT sent - recipient "${recipient}" is not on the safe-sender allowlist. ` +
          `Valid recipients on this server: ${valid}. ` +
          `If you meant to reply to the person who just messaged you, OMIT the recipient argument and the tool will default to them automatically. ` +
          `If you need to text someone new, the user has to add them in Settings → Channels (iMessage card) first.`;
        isError = true;
        auditLog(agentId, 'imessage_send', recipient, 'denied', 'recipient not in allowlist');
        return { content, isError };
      }
      recipient = match.address; // canonicalize formatting
      if (inboundSender) {
        const inboundMatch = findSafeSenderByAddress(safeRecords, inboundSender);
        const inboundAddr = inboundMatch?.address ?? inboundSender;
        if (inboundAddr !== recipient) {
          switchedFromInbound = inboundAddr;
        }
      }
    }

    const recipientRecord = findSafeSenderByAddress(safeRecords, recipient);

    // v2.9.15, removed the "dashboard-active" channel-context guard
    // that used to refuse imessage_send when the most recent user-role
    // message lacked the iMessage source tag and was less than 60s
    // old. The guard's intent was to prevent the model from texting
    // the user while they were typing in dashboard, but in practice
    // it (a) treated every non-iMessage inbound (email, Teams, A2A,
    // task wake-ups stored as user-role) as "dashboard activity" and
    // refused legitimate sends, (b) blocked explicit user requests
    // like "iMessage me X" issued from the dashboard, and (c) blocked
    // task-directed sends ("when work completes, iMessage the user
    // with the result") whenever those tasks finished within 60s of
    // any other inbound. The default-channel hint stays in the tool
    // description (HARD RULE), but the engine no longer second-
    // guesses an explicit imessage_send call.

    // ── Attachment pre-flight ────────────────────────────────────
    // Fail-fast on any missing file before any bytes go over the
    // wire. Partial sends (some attachments delivered, some not)
    // are worse than no send because the recipient sees a fragment
    // and the agent can't tell which.
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
          // iMessage tops out around 100MB per attachment. Pre-check
          // size and refuse cleanly rather than handing a too-large
          // file to imsg and waiting for it to time out.
          const MAX_IMESSAGE_BYTES = 100 * 1024 * 1024;
          if (stat.size > MAX_IMESSAGE_BYTES) {
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

    // ── Send ─────────────────────────────────────────────────────
    const result = sendIMessageWithAttachments(recipient, message, attachmentPaths);
    if (!result.ok && result.sentFiles.length === 0 && !result.textSent) {
      content =
        'iMessage delivery failed at the system level - neither the imsg CLI nor AppleScript could deliver. ' +
        'Tell the user the message did not go through, and respond in the dashboard chat instead. ' +
        'The user can check System Settings - Privacy & Security - Automation to grant Messages access if AppleScript is the issue.';
      isError = true;
      auditLog(agentId, 'imessage_send', recipient, 'error', 'send returned false');
      return { content, isError };
    }

    // Double-send prevention is turn-state now (P5c): the executor records
    // this send in repliedToCounterpartyThisTurn (D16) and the end-of-turn
    // auto-route checks it, so an explicit reply to the counterparty
    // suppresses the engine's own.


    // ── Success string (with recipient-switching warning) ────────
    // If the agent receives an iMessage from sender A and then sends
    // to sender B's address explicitly, the success string makes
    // that switch loud so the user sees it in the chat log.
    const recipientLabel = recipientRecord
      ? `${recipientRecord.name} (${recipientRecord.address})`
      : recipient;
    const attachSummary = attachmentPaths.length > 0
      ? ` with ${result.sentFiles.length}/${attachmentPaths.length} attachment(s)${result.failedFiles.length > 0 ? ` (failed: ${result.failedFiles.join(', ')})` : ''}`
      : '';
    const switchNote = switchedFromInbound
      ? ` NOTE: this was a SWITCH - the inbound that triggered this turn came from ${switchedFromInbound}, but you sent to ${recipientLabel} instead. Confirm this was intentional.`
      : '';
    // Audit detail captures the full sharing context so a later review
    // can answer "did the primary agent over-share with sender X?" without
    // reconstructing from chat history. We log the recipient's
    // sharing_level, whether this was a reply or a switch, and the
    // inbound sender (when applicable).
    const auditDetailParts: string[] = [
      `Sent ${message.length} chars`,
    ];
    if (attachmentPaths.length > 0) {
      auditDetailParts.push(`+ ${result.sentFiles.length}/${attachmentPaths.length} attachments`);
    }
    if (recipientRecord) {
      auditDetailParts.push(`recipientLevel=${recipientRecord.sharing_level}`);
    }
    if (inboundSender) {
      auditDetailParts.push(
        switchedFromInbound
          ? `inboundSender=${inboundSender} (SWITCH)`
          : `inboundSender=${inboundSender} (reply)`,
      );
    } else {
      auditDetailParts.push('proactive');
    }
    auditLog(agentId, 'imessage_send', recipient, 'success', auditDetailParts.join(' | '));
    // C26 tier 3: iMessage is honestly UNVERIFIABLE (only an AppleScript /
    // imsg exit code, no provider id exists). Write an exit-code receipt so
    // PM and the user-facing story never pretend it was confirmed. This
    // imposes NO new gate requirement (tier-3-only turns are unchanged).
    // skipAudit: the rich over-share audit row above is the provenance row.
    writeToolReceipt({ agentId, tool: 'imessage_send', tier: 3, verified: false, basis: 'exit-code', recipient, sentText: message, detail: { textSent: result.textSent, attachmentsSent: result.sentFiles.length }, skipAudit: true });
    content = `iMessage sent to ${recipientLabel}${attachSummary}.${switchNote}`;
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
    // T10: share_publicly mints an unauthenticated URL — gate it first.
    const publishGuard = await sharePathGuard(agentId, 'share_publicly', sourcePath);
    if (!publishGuard.allowed) {
      auditLog(agentId, 'share_publicly', publishGuard.absPath, 'denied', publishGuard.reason);
      content = publishGuard.blockedMessage ?? permissionDeniedMessage(publishGuard.reason, agentId);
      isError = true;
      return { content, isError };
    }
    try {
      const result = createPublicShare({ sourcePath, entryFilename });
      auditLog(agentId, 'share_publicly', sourcePath, 'success', `Slug ${result.slug}, base ${result.baseSource}`);
      const tunnelLine = result.baseSource === 'tunnel'
        ? 'Cloudflare tunnel is active, this URL is reachable from anywhere on the internet.'
        : 'No tunnel is running, so this URL only works from the same machine. To share off-device, start the Cloudflare tunnel from the dashboard and run share_publicly again.';
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
      auditLog(agentId, 'share_publicly', sourcePath, 'error', msg);
      content = `Error sharing file: ${msg}`;
      isError = true;
    }
    return { content, isError };
  },

  async "sms_send"({ agentId, args }) {
    let content = '';
    let isError = false;
    if (!isPrimaryAgent(agentId)) {
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
      // C26: the receipt writer emits the single provenance audit row
      // (target=sms_send, detail=receipt=<id>) and captures the Twilio
      // SID as the provider id, so we no longer double-write an audit row.
      // A 2xx with no SID cannot be confirmed: fail the turn.
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
    if (!isPrimaryAgent(agentId)) {
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
      from: args.from as string | undefined,
    });
    content = result.message;
    isError = !result.ok;
    if (result.ok) {
      // C26: fold the audit row into the receipt writer and capture the
      // Twilio call SID as the provider id. No SID = unverifiable, fail.
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
    if (!isPrimaryAgent(agentId)) {
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
    if (!isPrimaryAgent(agentId)) {
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
