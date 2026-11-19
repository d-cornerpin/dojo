// iMessage bridge: polls chat.db for inbound texts and attachments and sends outbound messages.

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { resolveOrCreateConversation } from '../memory/conversations.js';
import { handleIMCommand } from './imessage-commands.js';
import { dojoVoice, tellAgentWhatDojoSent, tellAgentOwnerAlertSent } from '../agent/dojo-voice.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { activeRuns, agentStartTimes } from '../agent/shared-state.js';
import { turnContext } from '../agent/turn-context.js';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { scrubTechnicalDetail } from '../agent/v2/error-format.js';
import { recordInboundMeta } from '../agent/v2/inbound-channel.js';
import { insertMessageIfAbsent, sweepById, type NewMessage } from '../memory/message-store.js';
import { replaceAskTitleFromModel } from '../work/ask-title.js';
import { isContentFreeCourtesy } from '../agent/v2/classifiers/inbound-courtesy.js';
import { appleMessageDateToUnixMs } from './imessage-date.js';
import { sanitizeForIMessage } from './imessage-sanitize.js';
import { recordAtDoor, withOutboundAsync, withOutboundAsyncIfAbsent, PLATFORM_SENDER, recordedId } from '../agent/v2/outbound.js';
import { runMessagesProgram, wasCutByTheStop, wasNeverStarted, getImsgPath, IMSG_CANDIDATE_PATHS, convertHeicToJpeg } from './imessage-run.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { inboundIMessageText } from '../tools/inbound-fences.js';
import { homeDir } from '../home.js';
import {
  type SafeSender, parseSafeSenders, findSafeSenderByAddress, ownerIMessageRecord, recipientKind,
} from './safe-senders.js';

// Attachments: each file joined to a chat.db message is copied into `~/.dojo/uploads/<agentId>/` (HEIC to JPEG)
// as an `UploadedFile[]` in the shape the /upload route writes, so `injectAttachmentBlocks` reads it. Files that
// cannot be delivered are only mentioned by name in the message text; the U+FFFC placeholder is stripped.

interface IMessageAttachmentRow {
  ROWID: number;
  filename: string | null;
  mime_type: string | null;
  transfer_name: string | null;
}

// Mirror of upload.ts UploadedFile: same shape, so attachment injection reads both without branching.
interface UploadedFile {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'video' | 'unknown';
}

const DOJO_UPLOAD_DIR = path.join(homeDir(), '.dojo', 'uploads');
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const HEIC_MIMES = new Set(['image/heic', 'image/heif']);
const PDF_MIMES = new Set(['application/pdf']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.webm', '.caf', '.amr']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.3gp']);

// Attachment-readiness race: the file can land seconds after its chat.db row, so before advancing past a message
// that claims attachments every file must be on disk; else retry next poll, up to MAX_ATTACHMENT_RETRIES (~60 s).

const MAX_ATTACHMENT_RETRIES = 12;
const deferredAttachmentRetries = new Map<number, number>();

// Text-ish files under `INLINE_TEXT_MAX_BYTES` are inlined; the list is duplicated from `gateway/routes/upload.ts`.
const INLINE_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.js', '.ts', '.py', '.html', '.css',
  '.sh', '.yaml', '.yml', '.toml', '.env', '.tsx', '.jsx', '.sql', '.rs',
  '.go', '.java', '.rb', '.php', '.swift', '.kt', '.c', '.cpp', '.h', '.log',
]);
const INLINE_TEXT_MAX_BYTES = 64 * 1024; // 64 KB per text file

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface MentionedAttachment {
  name: string;
  mimeType: string;
  size: number;
  reason: string; // short human-readable reason for the mention-only path
}

interface ImessageAttachmentResult {
  uploadedFiles: UploadedFile[];   // image/PDF copied to disk, runtime injects as content blocks
  inlinedTextBlocks: string[];     // small text files read + framed for the message body
  mentionedAttachments: MentionedAttachment[]; // everything else, metadata only
}

function ensureImessageUploadDir(agentId: string): string {
  const dir = path.join(DOJO_UPLOAD_DIR, agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function expandHomedir(p: string): string {
  if (p.startsWith('~/')) return path.join(homeDir(), p.slice(2));
  if (p === '~') return homeDir();
  return p;
}

function safeFilenamePart(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function stripAttachmentPlaceholder(text: string | null): string {
  return (text ?? '').replace(/\uFFFC/g, '').trim();
}

// Read-only probe for the poll loop: ready when the message has no attached files or every file exists on disk.
function isMessageAttachmentReady(
  chatDb: Database.Database,
  messageRowid: number,
): { ready: true } | { ready: false; reason: string } {
  const rows = chatDb.prepare(`
    SELECT a.ROWID, a.filename
    FROM message_attachment_join maj
    JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = ?
  `).all(messageRowid) as Array<{ ROWID: number; filename: string | null }>;

  if (rows.length === 0) return { ready: true };

  for (const row of rows) {
    if (!row.filename) continue; // attachment row exists but no path, skip it silently
    const srcPath = expandHomedir(row.filename);
    if (!fs.existsSync(srcPath)) {
      return {
        ready: false,
        reason: `attachment ${row.ROWID} not yet on disk: ${srcPath}`,
      };
    }
  }
  return { ready: true };
}

export function fetchImessageAttachments(
  chatDb: Database.Database,
  messageRowid: number,
  agentId: string,
): ImessageAttachmentResult {
  const rows = chatDb.prepare(`
    SELECT a.ROWID, a.filename, a.mime_type, a.transfer_name
    FROM message_attachment_join maj
    JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = ?
    ORDER BY a.ROWID ASC
  `).all(messageRowid) as IMessageAttachmentRow[];

  const result: ImessageAttachmentResult = {
    uploadedFiles: [],
    inlinedTextBlocks: [],
    mentionedAttachments: [],
  };

  if (rows.length === 0) return result;

  const dir = ensureImessageUploadDir(agentId);

  for (const row of rows) {
    if (!row.filename) continue;
    const srcPath = expandHomedir(row.filename);

    if (!fs.existsSync(srcPath)) {
      logger.warn('iMessage attachment file missing on disk, skipping', {
        attachmentId: row.ROWID,
        srcPath,
      });
      continue;
    }

    const mimeType = (row.mime_type ?? '').toLowerCase();
    const displayName = row.transfer_name || path.basename(srcPath);
    const ext = path.extname(displayName).toLowerCase();
    const fileId = uuidv4();
    const timestamp = Date.now();

    let srcSize = 0;
    try { srcSize = fs.statSync(srcPath).size; } catch { /* leave 0 */ }

    try {
      if (IMAGE_MIMES.has(mimeType)) {
        const storedName = `imessage_${timestamp}_${row.ROWID}_${safeFilenamePart(displayName)}`;
        const destPath = path.join(dir, storedName);
        fs.copyFileSync(srcPath, destPath);
        const size = fs.statSync(destPath).size;
        result.uploadedFiles.push({
          fileId, filename: displayName, mimeType, size, path: destPath, category: 'image',
        });
        logger.info('iMessage image attached', { fileId, displayName, size });
        continue;
      }

      if (HEIC_MIMES.has(mimeType)) {
        // Vision models reject HEIC: convert to JPEG via macOS's `sips`.
        const jpegBase = safeFilenamePart(displayName).replace(/\.(heic|heif)$/i, '.jpg');
        const jpegName = `imessage_${timestamp}_${row.ROWID}_${jpegBase}`;
        const destPath = path.join(dir, jpegName);
        convertHeicToJpeg(srcPath, destPath);
        if (!fs.existsSync(destPath)) {
          logger.warn('HEIC conversion produced no output, mentioning instead', {
            srcPath, destPath,
          });
          result.mentionedAttachments.push({
            name: displayName,
            mimeType,
            size: srcSize,
            reason: 'HEIC conversion failed',
          });
          continue;
        }
        const size = fs.statSync(destPath).size;
        result.uploadedFiles.push({
          fileId,
          filename: displayName.replace(/\.(heic|heif)$/i, '.jpg'),
          mimeType: 'image/jpeg',
          size,
          path: destPath,
          category: 'image',
        });
        logger.info('iMessage HEIC converted and attached', { fileId, displayName, size });
        continue;
      }

      if (PDF_MIMES.has(mimeType)) {
        const storedName = `imessage_${timestamp}_${row.ROWID}_${safeFilenamePart(displayName)}`;
        const destPath = path.join(dir, storedName);
        fs.copyFileSync(srcPath, destPath);
        const size = fs.statSync(destPath).size;
        result.uploadedFiles.push({
          fileId, filename: displayName, mimeType, size, path: destPath, category: 'pdf',
        });
        logger.info('iMessage PDF attached', { fileId, displayName, size });
        continue;
      }

      // Audio and video bytes are copied so the agent can route them through transcribe_audio.
      const isAudioByMime = mimeType.startsWith('audio/');
      const isVideoByMime = mimeType.startsWith('video/');
      const isAudioByExt = AUDIO_EXTENSIONS.has(ext);
      const isVideoByExt = VIDEO_EXTENSIONS.has(ext);
      if (isAudioByMime || isAudioByExt || isVideoByMime || isVideoByExt) {
        const category: UploadedFile['category'] = (isAudioByMime || isAudioByExt) ? 'audio' : 'video';
        const storedName = `imessage_${timestamp}_${row.ROWID}_${safeFilenamePart(displayName)}`;
        const destPath = path.join(dir, storedName);
        fs.copyFileSync(srcPath, destPath);
        const size = fs.statSync(destPath).size;
        const inferredMime =
          mimeType
          || (category === 'audio'
            ? (ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg')
            : (ext === '.mp4' ? 'video/mp4' : ext === '.mov' ? 'video/quicktime' : 'video/mp4'));
        result.uploadedFiles.push({
          fileId, filename: displayName, mimeType: inferredMime, size, path: destPath, category,
        });
        logger.info(`iMessage ${category} attached`, { fileId, displayName, size, mimeType: inferredMime });
        continue;
      }

      const looksLikeText = mimeType.startsWith('text/') || INLINE_TEXT_EXTENSIONS.has(ext);
      if (looksLikeText) {
        if (srcSize > INLINE_TEXT_MAX_BYTES) {
          result.mentionedAttachments.push({
            name: displayName,
            mimeType: mimeType || `text/${ext.slice(1) || 'plain'}`,
            size: srcSize,
            reason: `text file too large to inline (${formatBytes(srcSize)}, cap ${formatBytes(INLINE_TEXT_MAX_BYTES)})`,
          });
          logger.info('iMessage text file too large, mentioning', { displayName, size: srcSize });
          continue;
        }
        try {
          const content = fs.readFileSync(srcPath, 'utf8');
          const header = `[Text file: ${displayName} — ${formatBytes(srcSize)}]`;
          const footer = `[end of ${displayName}]`;
          result.inlinedTextBlocks.push(`${header}\n${content}\n${footer}`);
          logger.info('iMessage text file inlined', { displayName, size: srcSize });
          continue;
        } catch (err) {
          result.mentionedAttachments.push({
            name: displayName,
            mimeType: mimeType || 'text/plain',
            size: srcSize,
            reason: `couldn't read as text (${err instanceof Error ? err.message : String(err)})`,
          });
          continue;
        }
      }

      // Anything else is mention only, no bytes copied: the filename, MIME type and size go in the message body.
      result.mentionedAttachments.push({
        name: displayName,
        mimeType: mimeType || 'application/octet-stream',
        size: srcSize,
        reason: 'format not yet deliverable to models — metadata only',
      });
      logger.info('iMessage attachment mentioned (not delivered)', {
        displayName, mimeType, size: srcSize,
      });
    } catch (err) {
      logger.warn('Failed to process iMessage attachment, mentioning instead', {
        displayName,
        mimeType,
        error: err instanceof Error ? err.message : String(err),
      });
      result.mentionedAttachments.push({
        name: displayName,
        mimeType: mimeType || 'application/octet-stream',
        size: srcSize,
        reason: `processing error (${err instanceof Error ? err.message : String(err)})`,
      });
    }
  }

  return result;
}

// When retries are exhausted the MODEL still gets an honest note that something was sent but never arrived. Run
// AFTER fetchImessageAttachments so files that did arrive are not duplicated.
function describeUnreadyAttachments(
  chatDb: Database.Database,
  messageRowid: number,
): MentionedAttachment[] {
  const rows = chatDb.prepare(`
    SELECT a.ROWID, a.filename, a.mime_type, a.transfer_name, a.total_bytes
    FROM message_attachment_join maj
    JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = ?
    ORDER BY a.ROWID ASC
  `).all(messageRowid) as Array<{
    ROWID: number;
    filename: string | null;
    mime_type: string | null;
    transfer_name: string | null;
    total_bytes: number | null;
  }>;

  const out: MentionedAttachment[] = [];
  for (const row of rows) {
    const srcPath = row.filename ? expandHomedir(row.filename) : null;
    if (srcPath && fs.existsSync(srcPath)) continue;
    out.push({
      name: row.transfer_name || (srcPath ? path.basename(srcPath) : `attachment ${row.ROWID}`),
      mimeType: (row.mime_type ?? 'application/octet-stream').toLowerCase(),
      size: row.total_bytes ?? 0,
      reason: 'sent but never finished downloading to this Mac (iCloud sync); tell the sender it did not arrive and ask them to resend',
    });
  }
  return out;
}

const logger = createLogger('imessage');

// Records, parser and owner rule live in `./safe-senders.ts`: the one reader of who the owner is on iMessage.
export {
  type SharingLevel, SHARING_LEVELS, type SafeSender, parseSafeSenders, addressesMatch,
  findSafeSenderByAddress,
} from './safe-senders.js';

/** The sharing-policy paragraph for an inbound's framing: soft enforcement, the model still chooses what to say. */
function buildSharingPolicyLine(sender: SafeSender, records: readonly SafeSender[]): string {
  const primary = records.find(s => s.is_primary);
  const primaryName = primary?.name?.trim() || 'the primary user';
  // Never point the agent at "ask the primary user" when the SENDER is the primary user.
  const askPrimary =
    sender.is_primary || sender.sharing_level === 'open_book'
      ? ''
      : ` If in doubt about whether something is OK to share, ask ${primaryName} first - reach them via BOTH the dashboard chat AND iMessage so they see your question on whichever channel they're checking. Wait for their answer before responding to the sender.`;

  switch (sender.sharing_level) {
    case 'open_book':
      return 'SHARING POLICY: Open Book. No restrictions - share schedule, contacts, files, ongoing projects, and personal details freely. Treat this sender as the owner.';
    case 'dont_overshare':
      return `SHARING POLICY: Don't Over-Share. Share what's asked and what's directly relevant to the conversation. Do NOT proactively dump information they didn't ask for (schedule details, contact info, project status, etc.). Hold back credentials, financials, and anything explicitly marked confidential.${askPrimary}`;
    case 'cautious':
      return `SHARING POLICY: Be Cautious. Answer only what is directly asked, briefly. Never volunteer schedule, contacts, or project details unprompted. If asked something personal, stay high-level (e.g., "${primaryName} is busy this afternoon" - NOT specific meeting names or times). When in doubt, share less rather than more.${askPrimary}`;
    case 'project_only':
      return `SHARING POLICY: Project Only. Discuss ONLY the specific project or topic this contact is collaborating on (see the sender description for the scope). If asked anything off-topic - personal life, schedule, contacts, other projects - politely refuse and redirect back to the project at hand.${askPrimary}`;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let approvedSenders: SafeSender[] = [];
let lastSeenRowId = 0;
const POLL_INTERVAL_MS = 5000;

// Offline replay: after days offline the cursor is stale. Stale safe-sender rows are INGESTED as notes (real send
// time, swept from the waiting set: no wake, command or auto-reply). Only the newest IMESSAGE_STALE_BACKLOG_CAP per
// poll are ingested; the rest are skipped and the cursor advances.
const IMESSAGE_MAX_REPLAY_AGE_MS = 48 * 60 * 60 * 1000;
const IMESSAGE_STALE_BACKLOG_CAP = 25;

// True while pollMessages is mid-flight: the next tick is skipped so two polls never read chat.db or advance
// lastSeenRowId concurrently. Turn serialization is the runtime's job (activeRuns + pendingWakeups).
let pollInFlight = false;

// Bounded retry for rows whose persist INSERT failed: the cursor never advances past an unpersisted row, but after
// MAX_PERSIST_RETRIES polls it advances with a loud error so an always-failing row cannot wedge the bridge.
const MAX_PERSIST_RETRIES = 12;
const persistRetries = new Map<number, number>();

// Sync-re-insert dedup: iCloud sync can re-insert an old message under a fresh, higher ROWID. A bounded ring of
// recently processed chat.db `guid`s skips them, mirrored into `config` so a restart keeps it.
const RECENT_GUID_LIMIT = 200;
const RECENT_GUIDS_CONFIG_KEY = 'imessage_recent_guids';
let recentGuids: string[] = []; // insertion order, oldest first
let recentGuidSet = new Set<string>();
let recentGuidsLoaded = false;

// Busy-ack: when an authorized sender's iMessage lands while a LONG turn (older than 60 s) is running, send ONE
// deterministic engine ack per sender per running turn so they know they were heard. Never a model turn.
const BUSY_ACK_TURN_AGE_MS = 60_000;
const BUSY_ACK_TEXT = 'Dojo: your message arrived, but the agent is in the middle of a longer task. It will get to your message when that turn ends.';
// agentId -> the running turn (identified by its start timestamp) + senders acked for it
const busyAckState = new Map<string, { turnStartedAt: number; ackedSenders: Set<string> }>();

export function maybeSendBusyAck(agentId: string, sender: string): void {
  // Only when a turn is ALREADY running (checked before this message is dispatched) and older than 60 s.
  if (!activeRuns.has(agentId)) return;
  const turnStartedAt = agentStartTimes.get(agentId);
  if (!turnStartedAt) return;
  if (Date.now() - turnStartedAt < BUSY_ACK_TURN_AGE_MS) return;
  let st = busyAckState.get(agentId);
  if (!st || st.turnStartedAt !== turnStartedAt) {
    st = { turnStartedAt, ackedSenders: new Set<string>() };
    busyAckState.set(agentId, st);
  }
  const key = canonicalContactAddress(sender);
  if (st.ackedSenders.has(key)) return; // at most once per sender per running turn
  st.ackedSenders.add(key);
  // Attributed to the agent's lane (this agent is why the person is waiting); labelled Dojo; the agent is told once the send is done.
  void withOutboundAsyncIfAbsent(
    { agentId, tool: 'busy-ack', channel: 'imessage', recipientId: sender },
    () => sendIMessage(sender, BUSY_ACK_TEXT),
  ).then((ok) => tellAgentWhatDojoSent({ agentId, recipient: sender, text: BUSY_ACK_TEXT, why: 'because your turn was still running when their text arrived', sent: ok === true }), () => tellAgentWhatDojoSent({ agentId, recipient: sender, text: BUSY_ACK_TEXT, why: 'because your turn was still running when their text arrived', sent: false }));
  // No 'queued' broadcast: the busy-ack above tells the person and the 30 s heartbeat re-asserts 'working'.
  logger.info('Busy-ack sent: inbound iMessage queued behind a running turn', {
    agentId,
    to: recipientKind(sender),
    turnAgeMs: Date.now() - turnStartedAt,
  });
}

// A reply routes to the sender of the message it answers through structural identity: the turn's counterparty
// (`TurnContext.imRecipient`, from the persisted inbound_meta / conversation row); `repliedToCounterpartyThisTurn`
// suppresses the end-of-turn auto-route after an explicit send. A row with no inbound_meta resolves no recipient.

/** The TURN's iMessage counterparty only, no last-inbound fallback; null means the caller must refuse to guess. */
export function getTurnScopedImRecipient(agentId: string): string | null {
  // Read from the turn's ADDRESS (the one record of who this turn talks to), not a second field.
  const a = turnContext(agentId)?.address;
  return a && a.kind === 'person' && a.inboundChannel === 'imessage' && a.senderId ? a.senderId : null;
}

// Resolves to the stored safe-sender address so phone punctuation and email case compare equal.
function canonicalContactAddress(address: string): string {
  const match = findSafeSenderByAddress(getSafeSenders(), address);
  return (match?.address ?? address).trim().toLowerCase();
}

/** Strips dashboard-only routing tags (e.g. "[SENT VIA IMESSAGE to <owner>]") the LLM copied into its reply. */
export function stripSystemTags(text: string): string {
  return text
    .replace(/\s*\[SENT VIA IMESSAGE to [^\]]+\][^\n]*\n?/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CHAT_DB_PATH = path.join(homeDir(), 'Library', 'Messages', 'chat.db');

function loadLastSeenRowId(): number {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM config WHERE key = 'imessage_last_rowid'`).get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function saveLastSeenRowId(rowId: number): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES ('imessage_last_rowid', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(String(rowId), String(rowId));
  } catch (err) {
    logger.error('Failed to save last seen rowid', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Loads the persisted recent-guid ring once per process; a missing or garbled value starts empty.
function loadRecentGuids(): void {
  if (recentGuidsLoaded) return;
  recentGuidsLoaded = true;
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM config WHERE key = ?`).get(RECENT_GUIDS_CONFIG_KEY) as { value: string } | undefined;
    if (!row) return;
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return;
    recentGuids = parsed.filter((g): g is string => typeof g === 'string').slice(-RECENT_GUID_LIMIT);
    recentGuidSet = new Set(recentGuids);
  } catch (err) {
    logger.warn('Failed to load recent iMessage guids, starting empty', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Records a guid as processed and persists the trimmed ring; a guid already in the set is a no-op.
function rememberProcessedGuid(guid: string | null): void {
  if (!guid || recentGuidSet.has(guid)) return;
  recentGuids.push(guid);
  recentGuidSet.add(guid);
  while (recentGuids.length > RECENT_GUID_LIMIT) {
    const evicted = recentGuids.shift();
    if (evicted !== undefined) recentGuidSet.delete(evicted);
  }
  try {
    const db = getDb();
    const json = JSON.stringify(recentGuids);
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(RECENT_GUIDS_CONFIG_KEY, json, json);
  } catch (err) {
    logger.warn('Failed to persist recent iMessage guids', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The single per-message inbound processor, shared by the poll loop AND the dev probe (gateway/routes/dev.ts).
 * Order: command intercept, else persist and dispatch to the primary agent. handleIMCommand owns the owner gate:
 * a non-owner's command text returns null and flows as chat; a real command is answered and the agent NOT woken.
 * `advanceRowId` (poll loop only) commits atomically with the INSERT; `wakeAgent` gates ONLY the runtime dispatch.
 */
export interface InboundIMessageInput {
  sender: string;
  cleanedText: string;
  attachmentResult?: ImessageAttachmentResult;
  advanceRowId: number | null;
  wakeAgent: boolean;
  // The chat.db guid, stored as external_message_id; its unique index is the durable dedup.
  externalMessageId?: string | null;
  /** Real send time (ISO) of a stale reconnect replay: ingested as a note, no command, wake or auto-reply. */
  staleSentAtIso?: string | null;
}

export type InboundIMessageOutcome =
  | { outcome: 'command'; reply: string; messageId: null }
  | { outcome: 'dispatched'; reply: null; messageId: string };

export async function processInboundIMessage(
  input: InboundIMessageInput,
): Promise<InboundIMessageOutcome> {
  const { sender, cleanedText, advanceRowId, wakeAgent, externalMessageId } = input;
  const attachmentResult: ImessageAttachmentResult =
    input.attachmentResult ?? { uploadedFiles: [], inlinedTextBlocks: [], mentionedAttachments: [] };
  const primaryId = getPrimaryAgentId();
  const safeSenders = getSafeSenders();

  const totalAttachmentCount =
    attachmentResult.uploadedFiles.length +
    attachmentResult.inlinedTextBlocks.length +
    attachmentResult.mentionedAttachments.length;

  // Command intercept on the text portion only: the reply goes to the SENDER and the agent stays asleep. Stale
  // replays skip it (a days-old "status" must not be answered on reconnect).
  if (cleanedText && !input.staleSentAtIso) {
    const commandResponse = await handleIMCommand(cleanedText, sender);
    if (commandResponse) {
      const sentOk = await sendIMessage(sender, commandResponse);
      tellAgentWhatDojoSent({ agentId: primaryId, recipient: sender, text: commandResponse, why: 'in reply to the text command they sent', sent: sentOk === true });
      return { outcome: 'command', reply: commandResponse, messageId: null };
    }
  }

  const db = getDb();
  const msgId = uuidv4();

  // The forwarded body: the caption, inlined text files, and a footer listing attachments not delivered as bytes.
  const bodyParts: string[] = [];
  if (cleanedText) {
    bodyParts.push(cleanedText);
  } else if (totalAttachmentCount > 0) {
    bodyParts.push(totalAttachmentCount === 1
      ? '(attached without a caption)'
      : `(${totalAttachmentCount} files attached without a caption)`);
  }

  if (attachmentResult.inlinedTextBlocks.length > 0) {
    bodyParts.push(attachmentResult.inlinedTextBlocks.join('\n\n'));
  }

  // Audio / video need an inline pointer to the fileId so the agent can call transcribe_audio.
  const audioOrVideoUploads = attachmentResult.uploadedFiles.filter(
    (f) => f.category === 'audio' || f.category === 'video',
  );
  if (audioOrVideoUploads.length > 0) {
    const lines = audioOrVideoUploads.map((f) => {
      const label = f.category === 'audio' ? 'Audio' : 'Video';
      return (
        `[${label} attached: ${f.filename} (${f.size} bytes), fileId: ${f.fileId}]\n` +
        `To transcribe what was said, call transcribe_audio with attachment_id="${f.fileId}".`
      );
    });
    bodyParts.push(lines.join('\n\n'));
  }

  if (attachmentResult.mentionedAttachments.length > 0) {
    const lines = attachmentResult.mentionedAttachments.map(m =>
      `  • ${m.name} (${m.mimeType}, ${formatBytes(m.size)}) — ${m.reason}`,
    );
    bodyParts.push(
      `[Other attachments this model can't directly process — let the sender know if the format isn't supported]:\n${lines.join('\n')}`,
    );
  }

  const textForModel = bodyParts.join('\n\n');

  // Sender identity and sharing policy in the framing: who sent it, who they are to the household, the reply recipient.
  const senderRecord = findSafeSenderByAddress(safeSenders, sender);
  // Avoid "user@example.com (user@example.com)" when the display name is just the address.
  const senderLabel = senderRecord
    ? (senderRecord.name && senderRecord.name !== senderRecord.address
        ? `${senderRecord.name} (${senderRecord.address})`
        : senderRecord.address) +
      (senderRecord.description ? ` - ${senderRecord.description}` : '')
    : sender;
  const replyHint = senderRecord
    ? `To reply, call imessage_send with recipient="${senderRecord.address}", or just write your reply and the engine delivers it. Do NOT pass any other safe-sender's address - that would send to the wrong person.`
    : `To reply, call imessage_send with recipient="${sender}", or just write your reply and the engine delivers it.`;
  const policyLine = senderRecord
    ? buildSharingPolicyLine(senderRecord, safeSenders)
    : `SHARING POLICY: Unknown sender - this address matched the bridge filter but isn't on the saved safe-sender list. Be cautious; share only what's directly asked. If in doubt, ask the primary user before responding.`;
  // Two discipline rules frame every inbound: the SHARING POLICY (what to share WITH the sender) and UPDATING THE
  // PRIMARY USER (whether and how to update them after replying). The default is silent: update only for something
  // they must know or be asked, with full context, since they do not see the iMessage thread.
  const primary = safeSenders.find(s => s.is_primary);
  const primaryName = primary?.name?.trim() || 'the primary user';
  const exampleName = senderRecord?.name ?? '<their name>';
  const exampleRelationship = senderRecord?.description ? ` (${senderRecord.description})` : '';
  // When the sender IS the primary user, the third-party "updating the primary user" paragraph would be
  // self-referential and its examples use third-party pronouns: the owner gets one plain framing line instead.
  const ownerSenderName = senderRecord?.name?.trim() || primaryName;
  const updateDiscipline = senderRecord?.is_primary
    ? `This is ${ownerSenderName}, your primary user, texting you directly via iMessage. Reply here; no separate update or permission is needed.`
    : `UPDATING THE PRIMARY USER: After you finish texting ${senderRecord?.name ?? 'this person'} back, do NOT send a separate update to ${primaryName} - NOT in the dashboard, and NOT as a separate iMessage to ${primaryName}'s address - UNLESS one of these is true: (a) you need to ASK ${primaryName} something to handle this conversation, or (b) there's specific information ${primaryName} genuinely needs to know. ${primaryName} does NOT see the iMessage thread between you and ${senderRecord?.name ?? 'this person'}; an unprompted "Sent." or "Standing by." or "Just the schedule, nothing else." reads as meaningless and confusing because they have no idea what you're referring to. If you DO send an update, ALWAYS lead with full context: who you were texting (name + relationship), what they asked you, and what you did or are waiting on. GOOD: "${exampleName}${exampleRelationship} just asked for your schedule this week - I sent them the calendar entries, no other personal details, and I'll let you know when they reply." BAD: "Sent. Just the schedule." Most iMessage exchanges should resolve silently from ${primaryName}'s perspective; only break that silence with real signal and real context.`;
  // No delivery header: the engine auto-routes the model's terminal text back via iMessage (reply-destination.ts).
  // The SOURCE tag below carries policy and sender identity.
  const theirText = inboundIMessageText(senderRecord?.is_primary === true, senderLabel, textForModel);
  let msgContent = `[SOURCE: IMESSAGE FROM ${senderLabel} - this person texted YOUR OWN iMessage account (the DOJO bridge - YOUR phone, not the user's). The text arrived via iMessage, not the dashboard chat. ${policyLine} ${replyHint} ${updateDiscipline} Respond to THIS topic only; do not pull in unrelated dashboard conversation context.] ${theirText}`;
  if (input.staleSentAtIso) {
    // The row keeps its real send time in-band (absolute, cache-safe) so the model reads it as history, not a fresh ask.
    msgContent = `[Delivered late: sent ${input.staleSentAtIso}, ingested when this Mac reconnected. Old context, not a fresh message; it was NOT answered at the time.] ${msgContent}`;
  }

  // Structured inbound meta, so the origin projection can tell the owner from a friend (is_primary).
  const inboundMetaObj = {
    channel: 'imessage' as const,
    accountKind: 'agent' as const,
    // Authorize ONLY when a safe-sender record exists, as email, SMS and Teams do: an unknown sender is downgraded
    // to a dashboard notice, never an auto-reply. Owner and known contacts both have a record.
    authorized: !!senderRecord,
    sender,
    recipientAddress: sender,
    chatType: 'dm' as const,
    relation: (senderRecord?.is_primary
      ? 'owner'
      : senderRecord
        ? 'known_contact'
        : 'third_party') as 'owner' | 'known_contact' | 'third_party',
    // Structured agent-ness of the sender, so downstream gates (ack suppression, courtesy damping) branch on data.
    senderIsAgent: !!senderRecord?.is_agent,
  };

  // Atomic persist: INSERT + inbound_meta (+ the poll loop cursor advance, when a ROWID is supplied) commit in ONE
  // transaction, so the cursor is never past an unpersisted row. Conversation identity is resolved BEFORE it.
  const conversationId = resolveOrCreateConversation(primaryId, {
    channel: 'imessage', provider: 'imessage', counterpartyId: sender,
    counterpartyName: senderRecord?.name ?? null, threadRoot: null,
  });
  // The routing facts already decided (inboundMetaObj) are stamped IN the insert so the row is never briefly
  // unstamped. insertMessageIfAbsent keeps the external_message_id dedup (ON CONFLICT DO NOTHING).
  const inboundRow: NewMessage = {
    id: msgId,
    agentId: primaryId,
    role: 'user',
    content: msgContent,
    attachments: attachmentResult.uploadedFiles.length > 0 ? JSON.stringify(attachmentResult.uploadedFiles) : null,
    conversationId,
    externalMessageId: externalMessageId ?? null,
    channel: inboundMetaObj.channel,
    senderId: inboundMetaObj.sender,
    authorized: inboundMetaObj.authorized,
  };
  let persisted: ReturnType<typeof insertMessageIfAbsent> = null;
  db.transaction(() => {
    // `conversationId` stays spelled in the write itself: identity is stamped ATOMICALLY with the row, and the
    // serve-boundary conformance walk reads exactly this statement.
    persisted = insertMessageIfAbsent({ ...inboundRow, conversationId });
    if (persisted !== null) {
      recordInboundMeta(msgId, inboundMetaObj);
      if (input.staleSentAtIso) {
        // A stale reconnect replay is a NOTE: claimable as context but swept from the waiting set (no late auto-reply).
        sweepById(msgId);
      }
    }
    if (advanceRowId !== null) {
      // The cursor moves even when the insert was the designed no-op: an old text re-inserted under a fresh ROWID
      // (the guid ring forgot it, the unique index did not) must still be passed, or the poll re-reads it forever.
      db.prepare(`
        INSERT INTO config (key, value, updated_at) VALUES ('imessage_last_rowid', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
      `).run(String(advanceRowId), String(advanceRowId));
    }
  })();

  if (persisted === null) {
    // This guid is already stored: a broadcast for an unstored id would render a bubble that vanishes on reload.
    logger.info('Inbound iMessage already stored (same guid), not shown or woken again', { rowid: advanceRowId });
    return { outcome: 'dispatched', reply: null, messageId: msgId };
  }

  // Everything below is POST-COMMIT: the row is durable and (poll loop) the cursor advanced, so a failure here
  // must never look like a persist failure to the caller (no retry or rollback).

  // The ask was filed with its own identifier inside the transaction above; the system model now writes the real
  // title over it, started here (fire-and-forget) since this bridge owns its outer transaction.
  void replaceAskTitleFromModel(inboundRow, msgId);

  try {
    broadcast({
      type: 'chat:message',
      agentId: primaryId,
      message: {
        id: msgId,
        agentId: primaryId,
        role: 'user' as const,
        content: msgContent,
        // Carry the SAME inbound_meta and conversationId as the DB row, so the origin stamp derives identical
        // attribution live and on refetch.
        conversationId,
        inboundMeta: JSON.stringify(inboundMetaObj),
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
        // Attachments ride the WS payload so the dashboard renders thumbnails the moment the iMessage arrives.
        ...(attachmentResult.uploadedFiles.length > 0
          ? { attachments: attachmentResult.uploadedFiles }
          : {}),
      },
    });

    // Courtesy damping: a KNOWN AGENT sender volleying content-free courtesy (a stock sign-off, or one of our own
    // ack-pool lines) must not wake a full turn. The row is already persisted; dispatch is skipped and a system
    // marker keeps history legible. Human senders and agent messages with real content fall through.
    const dampCourtesy =
      wakeAgent &&
      !!senderRecord?.is_agent &&
      !!cleanedText &&
      isContentFreeCourtesy(cleanedText);

    if (dampCourtesy && senderRecord) {
      const markerId = uuidv4();
      const markerContent = `[Courtesy reply from ${senderRecord.name} received; no turn taken]`;
      try {
        // The marker row and its frame both carry the conversationId, so live and reload agree.
        insertMessageIfAbsent({
          id: markerId, agentId: primaryId, role: 'system', content: markerContent, conversationId,
        });
        broadcast({
          type: 'chat:message',
          agentId: primaryId,
          message: {
            id: markerId, agentId: primaryId, role: 'system' as const,
            content: markerContent,
            conversationId,
            tokenCount: null, modelId: null, cost: null, latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
      } catch (markerErr) {
        logger.warn('Failed to persist courtesy-damping marker (non-fatal)', {
          error: markerErr instanceof Error ? markerErr.message : String(markerErr),
        });
      }
      logger.info('RC-8: damped content-free courtesy from agent sender (no turn taken)', {
        from: recipientKind(sender), name: senderRecord.name,
      });
    } else if (wakeAgent) {
      // Busy-ack: tell the sender once if this message queued behind a running turn older than 60 s. Never to another
      // Dojo's agent: the line would start a turn on that box.
      try {
        if (!senderRecord?.is_agent) maybeSendBusyAck(primaryId, sender);
      } catch (ackErr) {
        logger.warn('Busy-ack attempt failed (non-fatal)', {
          error: ackErr instanceof Error ? ackErr.message : String(ackErr),
        });
      }
      // Do NOT await the turn: the runtime serializes per agent and rows persist in ROWID order before dispatch.
      const runtime = getAgentRuntime();
      void runtime.handleMessage(primaryId, msgContent).catch(err => {
        logger.error('Failed to process iMessage in runtime', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (postErr) {
    logger.error('Post-persist broadcast/dispatch failed for inbound iMessage (row is persisted; re-drain will serve it)', {
      rowid: advanceRowId,
      error: postErr instanceof Error ? postErr.message : String(postErr),
    });
  }

  return { outcome: 'dispatched', reply: null, messageId: msgId };
}

async function pollMessages(): Promise<void> {
  if (!pollTimer) return;   // stopped: nothing is read, nothing is passed over
  // The list as it stood when this poll began: a stop (which empties the live list) or a quick
  // restart mid-batch must not make this poll judge its remaining texts against a different list.
  const sendersThisPoll = approvedSenders;
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    // Open the Messages database read-only
    const chatDb = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });

    try {
      // Every text after the cursor is read, whoever sent it; a sender not approved at THIS moment is passed over for
      // good below, so a removed sender's texts are never delivered later. No text filter: image-only rows hold U+FFFC.

      // Also selects associated_message_type, item_type and guid, which the filters below use.
      const messages = chatDb.prepare(`
        SELECT m.ROWID, m.text, m.is_from_me, m.date, m.cache_has_attachments,
               COALESCE(m.associated_message_type, 0) AS associated_message_type,
               COALESCE(m.item_type, 0) AS item_type, m.guid, c.chat_identifier
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE m.ROWID > ?
          AND m.is_from_me = 0
        ORDER BY m.ROWID ASC
        LIMIT 10
      `).all(lastSeenRowId) as Array<{
        ROWID: number;
        text: string | null;
        is_from_me: number;
        date: number;
        cache_has_attachments: number;
        associated_message_type: number;
        item_type: number;
        guid: string | null;
        chat_identifier: string;
      }>;

      // Advance-after-persist: a row's cursor advances in exactly one of two places: (a) a deliberate skip path
      // (non-safe-sender, empty reaction row, handled command, persist given up after retries) via advancePastRow, or
      // (b) the persist path, inside the SAME SQLite transaction as the message INSERT. A crash before the commit
      // leaves no row and an unmoved cursor (re-read); a crash after it leaves both durable and the boot re-drain
      // serves the waiting row, so the cursor is never past an unpersisted message.
      const advancePastRow = (rowId: number): void => {
        lastSeenRowId = rowId;
        saveLastSeenRowId(rowId);
        deferredAttachmentRetries.delete(rowId);
        persistRetries.delete(rowId);
      };

      // Classify the batch's stale rows up front so the cap keeps the NEWEST cap-many (rows arrive oldest-first).
      const staleRowids = new Set<number>();
      {
        const staleAll = messages.filter(m => {
          const t = appleMessageDateToUnixMs(m.date);
          return t !== null && Date.now() - t > IMESSAGE_MAX_REPLAY_AGE_MS;
        }).map(m => m.ROWID);
        for (const rid of staleAll) staleRowids.add(rid);
        for (const rid of staleAll.slice(-IMESSAGE_STALE_BACKLOG_CAP)) staleRowids.delete(rid);
        // staleRowids holds only the beyond-cap overflow (skipped); capped-in stale rows are ingested as notes below.
      }
      for (const msg of messages) {
        if (!pollTimer) {
          logger.info('iMessage poll cut short: the bridge was stopped mid-batch; remaining texts stay for the next start');
          break;
        }
        // Not approved now (never was, or removed): passed over for good, before anything is copied or stored.
        if (!findSafeSenderByAddress(sendersThisPoll, msg.chat_identifier)) {
          advancePastRow(msg.ROWID);
          continue;
        }
        // Offline replay: ingest as a note, or skip when beyond the cap. Before the attachment gate so an overflow message
        // never triggers copying. An undeterminable age (null) is processed normally: dropping a real text is worse.
        const sentAtMs = appleMessageDateToUnixMs(msg.date);
        const isStaleReplay = sentAtMs !== null && Date.now() - sentAtMs > IMESSAGE_MAX_REPLAY_AGE_MS;
        if (isStaleReplay && staleRowids.has(msg.ROWID)) {
          logger.info('iMessage stale-backlog overflow skipped (beyond the per-poll ingest cap; advancing cursor past it)', {
            rowid: msg.ROWID,
            ageHours: Math.round((Date.now() - sentAtMs) / 3_600_000),
          });
          advancePastRow(msg.ROWID); // deliberate skip, advance so it is never re-read
          continue;
        }

        // Contentless-artifact filter: tapbacks, edits, unsends and stickers (associated_message_type 2000-3007) and
        // group/system events (item_type != 0) carry nothing to read, and forwarding them makes a hollow envelope. Drop
        // them and advance the cursor (a consumed skip) BEFORE the attachment gate so they never trigger deferral or copying.
        if (msg.associated_message_type !== 0) {
          logger.debug('iMessage skipped, reaction/edit/unsend artifact row (advancing cursor past it)', {
            rowid: msg.ROWID,
            associatedMessageType: msg.associated_message_type,
          });
          advancePastRow(msg.ROWID);
          continue;
        }
        if (msg.item_type !== 0) {
          logger.debug('iMessage skipped, non-message system/group event (advancing cursor past it)', {
            rowid: msg.ROWID,
            itemType: msg.item_type,
          });
          advancePastRow(msg.ROWID);
          continue;
        }
        if (stripAttachmentPlaceholder(msg.text) === '' && msg.cache_has_attachments === 0) {
          logger.debug('iMessage skipped, empty text with no attachments (advancing cursor past it)', {
            rowid: msg.ROWID,
          });
          advancePastRow(msg.ROWID);
          continue;
        }

        // Sync-re-insert dedup: an iCloud re-insert of an already forwarded message (fresh ROWID, same guid) is skipped and
        // the cursor advances. Before the attachment gate so a long-gone attachment file cannot wedge it.
        if (msg.guid && recentGuidSet.has(msg.guid)) {
          logger.info('iMessage skipped, guid already processed (likely iCloud sync re-insert, advancing cursor past it)', {
            rowid: msg.ROWID,
            guid: msg.guid,
          });
          advancePastRow(msg.ROWID);
          continue;
        }

        // Set when the attachment-readiness race is lost below, so never-downloaded files are surfaced to the model.
        let attachmentDownloadGaveUp = false;

        // Attachment-readiness gate: if chat.db claims attachments that are not on disk yet, break out of this poll WITHOUT
        // advancing lastSeenRowId so the next poll retries, bounded by MAX_ATTACHMENT_RETRIES.
        if (msg.cache_has_attachments === 1) {
          const readiness = isMessageAttachmentReady(chatDb, msg.ROWID);
          if (!readiness.ready) {
            const retries = (deferredAttachmentRetries.get(msg.ROWID) ?? 0) + 1;
            if (retries < MAX_ATTACHMENT_RETRIES) {
              deferredAttachmentRetries.set(msg.ROWID, retries);
              logger.info('iMessage attachment not ready, deferring to next poll', {
                rowid: msg.ROWID,
                retry: retries,
                maxRetries: MAX_ATTACHMENT_RETRIES,
                reason: readiness.reason,
              });
              break; // stop processing this cycle, do NOT advance lastSeenRowId
            }
            // Give up: process the message without attachments so a broken download cannot wedge the bridge.
            logger.warn('iMessage attachment never became ready, processing without it', {
              rowid: msg.ROWID,
              retriesAttempted: retries,
              reason: readiness.reason,
            });
            deferredAttachmentRetries.delete(msg.ROWID);
            attachmentDownloadGaveUp = true;
          }
        }

        const sender = msg.chat_identifier;
        const primaryId = getPrimaryAgentId();

        // Tighten the SQL LIKE filter: the chat_identifier must match a saved safe-sender record (drops group chats).
        if (!findSafeSenderByAddress(sendersThisPoll, sender)) {
          logger.warn('iMessage dropped: chat_identifier matched SQL filter but no safe-sender record', {
            rowid: msg.ROWID,
          });
          advancePastRow(msg.ROWID); // deliberate skip, advance as before
          continue;
        }

        const cleanedText = stripAttachmentPlaceholder(msg.text);

        // Each attachment is delivered as bytes (image, PDF, audio, video), inlined text, or mention-only metadata.
        const attachmentResult = fetchImessageAttachments(chatDb, msg.ROWID, primaryId);

        // Retries exhausted: tell the MODEL an attachment was sent but never finished downloading, so it asks for a
        // resend instead of confabulating. Run AFTER the fetch so a late file is delivered and not double-listed.
        if (attachmentDownloadGaveUp) {
          const neverArrived = describeUnreadyAttachments(chatDb, msg.ROWID);
          if (neverArrived.length > 0) {
            attachmentResult.mentionedAttachments.push(...neverArrived);
            logger.info('iMessage give-up: surfaced never-downloaded attachments to the model', {
              rowid: msg.ROWID,
              count: neverArrived.length,
            });
          }
        }

        const totalAttachmentCount =
          attachmentResult.uploadedFiles.length +
          attachmentResult.inlinedTextBlocks.length +
          attachmentResult.mentionedAttachments.length;

        // Skip rows that are neither text nor any attachment (reactions, typing indicators).
        if (!cleanedText && totalAttachmentCount === 0) {
          logger.debug('iMessage skipped, no text and no attachments of any kind', {
            rowid: msg.ROWID,
          });
          advancePastRow(msg.ROWID); // deliberate skip, advance as before
          continue;
        }

        logger.info('iMessage received', {
          from: recipientKind(sender),
          textLength: cleanedText.length,
          uploaded: attachmentResult.uploadedFiles.length,
          inlined: attachmentResult.inlinedTextBlocks.length,
          mentioned: attachmentResult.mentionedAttachments.length,
        });


        // Command intercept and dispatch run through the ONE shared inbound processor the dev probe also drives. The
        // poll loop owns the chat.db cursor: it hands over the ROWID and retries persist failures here.
        let inboundOutcome;
        try {
          inboundOutcome = await processInboundIMessage({
            sender,
            cleanedText,
            attachmentResult,
            advanceRowId: msg.ROWID,
            // A stale reconnect replay is ingested as a note, never a turn.
            wakeAgent: !isStaleReplay,
            externalMessageId: (msg as { guid?: string | null }).guid ?? null,
            staleSentAtIso: isStaleReplay && sentAtMs !== null ? new Date(sentAtMs).toISOString() : null,
          });
        } catch (err) {
          // Persist failed: the message is NOT stored and the cursor was NOT advanced (rolled back). Retry this row next
          // poll, bounded so a permanently failing row cannot wedge the bridge; after the cap, advance past it loudly.
          const tries = (persistRetries.get(msg.ROWID) ?? 0) + 1;
          if (tries < MAX_PERSIST_RETRIES) {
            persistRetries.set(msg.ROWID, tries);
            logger.error('Failed to persist inbound iMessage, will retry next poll', {
              rowid: msg.ROWID,
              attempt: tries,
              maxRetries: MAX_PERSIST_RETRIES,
              error: err instanceof Error ? err.message : String(err),
            });
            break; // do not advance; re-read this row on the next poll
          }
          logger.error('Giving up on inbound iMessage after bounded persist retries, advancing past it', {
            rowid: msg.ROWID,
            attemptsMade: tries,
            error: err instanceof Error ? err.message : String(err),
          });
          advancePastRow(msg.ROWID);
          continue;
        }

        if (inboundOutcome.outcome === 'command') {
          // Command fully handled (reply already texted inside the processor): advance past the row.
          rememberProcessedGuid(msg.guid); // dedup a later iCloud re-insert
          advancePastRow(msg.ROWID);
          continue;
        }

        // Dispatched: the processor already advanced imessage_last_rowid atomically; sync the in-memory cursor.
        rememberProcessedGuid(msg.guid); // dedup a later iCloud re-insert
        lastSeenRowId = msg.ROWID;
        deferredAttachmentRetries.delete(msg.ROWID);
        persistRetries.delete(msg.ROWID);
      }
    } finally {
      chatDb.close();
    }
  } catch (err) {
    // Silently handle if Messages database is not accessible
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('SQLITE_CANTOPEN') && !msg.includes('no such file')) {
      logger.error('iMessage polling error', { error: msg });
    }
  } finally {
    pollInFlight = false;
  }
}

// An empty saved list is the owner removing the last sender: nobody is heard. Missing or unreadable is not an explicit list.
const savedListIsExplicit = (raw: string | undefined) => { try { return Array.isArray(JSON.parse(raw ?? '')); } catch { return false; } };

export function startIMBridge(recipientId: string): void {
  if (pollTimer) {
    logger.warn('iMessage bridge already running');
    return;
  }

  // Say at BOOT whether the attachment sender is healthy, not at the first failed send in the middle of the night.
  checkImsgHealth();

  // Load approved senders from config; the legacy recipient is used only when the value is missing or unreadable.
  const db = getDb();
  const sendersRow = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
  approvedSenders = parseSafeSenders(sendersRow?.value ?? null);
  if (approvedSenders.length === 0 && !savedListIsExplicit(sendersRow?.value)) {
    approvedSenders = [{
      address: recipientId,
      name: recipientId,
      description: undefined,
      is_primary: true,
      sharing_level: 'open_book',
    }];
  }

  lastSeenRowId = loadLastSeenRowId();
  loadRecentGuids();

  // If no stored lastSeenRowId (first run or reset), seed from the current max ROWID
  // so we only process messages received AFTER the bridge starts, not the entire history
  if (lastSeenRowId === 0) {
    try {
      const chatDb = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
      try {
        const maxRow = chatDb.prepare('SELECT MAX(ROWID) as maxId FROM message').get() as { maxId: number | null } | undefined;
        if (maxRow?.maxId) {
          lastSeenRowId = maxRow.maxId;
          saveLastSeenRowId(lastSeenRowId);
          logger.info('Seeded lastSeenRowId from Messages DB (first run)', { lastSeenRowId });
        }
      } finally {
        chatDb.close();
      }
    } catch (err) {
      // If we can't read chat.db, leave at 0, pollMessages will handle the error gracefully
      logger.warn('Could not seed lastSeenRowId from Messages DB', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Starting iMessage bridge', { approvedSenders, lastSeenRowId });

  pollTimer = setInterval(() => {
    pollMessages().catch(err => {
      logger.error('iMessage poll cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  pollMessages().catch(() => {});
}

export function stopIMBridge(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    approvedSenders = [];
    logger.info('iMessage bridge stopped');
  }
}

/** Re-reads imessage_approved_senders into the running bridge (a no-op when it is not running). */
export function reloadApprovedSenders(): void {
  if (!pollTimer) return;
  const db = getDb();
  const sendersRow = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
  const parsed = parseSafeSenders(sendersRow?.value ?? null);
  if (parsed.length === 0 && !savedListIsExplicit(sendersRow?.value)) {
    logger.warn('reloadApprovedSenders called but config key missing/unreadable - leaving in-memory list unchanged');
    return;
  }
  approvedSenders = parsed;
  logger.info('Reloaded approved senders from config', { count: approvedSenders.length });
}

// iMessage sending uses the `imsg` CLI (github.com/steipete/imsg), installed by the dojo installer, which handles
// text, files, phone normalization and service detection; AppleScript is the fallback.

// The candidate list and the runnability probe live with the runner (`./imessage-run.ts`).

// AppleScript fallback for a missing or failed imsg. `sendClause` is the script's own send line: `send "<text>"` or
// `send POSIX file "<path>"`. Two-bubble limitation vs imsg: a file goes alone and any caption is sent as its own
// text bubble by the caller.
// Select the iMessage service POSITIONALLY, not via `1st service whose service type = iMessage`: that filtered
// reference throws AppleScript error -10002 ("Invalid key form") on macOS 26. Iterate `services` checking each
// type; if none reports iMessage, fall back to `item 1 of services`.
// The script is osascript's own `-e` argument (no shell line, so no shell quoting), run by the async runner and
// bound to the sending agent's Stop. Rejects on failure.
function sendViaAppleScript(recipient: string, sendClause: string, timeout: number, opts: SendOpts): Promise<string> {
  const script = `
    tell application "Messages"
      set targetService to missing value
      repeat with s in services
        try
          if (service type of s) is iMessage then
            set targetService to s
            exit repeat
          end if
        end try
      end repeat
      if targetService is missing value then set targetService to item 1 of services
      set targetBuddy to buddy ${appleScriptString(recipient)} of targetService
      ${sendClause} to targetBuddy
    end tell
  `;
  return runMessagesProgram('osascript', ['-e', script], { timeout, agentId: opts.agentId });
}

// An AppleScript double-quoted literal: backslashes and double quotes escaped. Newlines can't
// appear inside a literal, so (for text) the literal is broken and joined with the linefeed constant.
const appleScriptString = (s: string, lines = false): string => {
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${lines ? escaped.replace(/\n/g, '" & (ASCII character 10) & "') : escaped}"`;
};

// The corrected imsg install command, shown wherever imsg is missing or broken. The PhoneNumberKit resource bundle
// MUST sit next to the binary: a bare copy of the binary crashes at launch, which looks like a send bug.
const IMSG_INSTALL_HINT =
  'git clone https://github.com/steipete/imsg.git && cd imsg && make build && ' +
  'sudo cp bin/imsg /opt/homebrew/bin/ && ' +
  'sudo cp .build/*/release/PhoneNumberKit_PhoneNumberKit.bundle /opt/homebrew/bin/ ' +
  '(the bundle must sit NEXT TO the binary or imsg crashes at launch)';

/** Boot-time imsg health probe: reports a broken imsg (resource bundle missing) LOUDLY with the repair command. */
export function checkImsgHealth(): void {
  const imsg = getImsgPath();
  if (imsg) {
    // findImsg only returns binaries that passed the runnability probe, so a non-null path IS the health signal;
    // name it so the boot log shows which copy won.
    logger.info('imsg CLI healthy', { path: imsg });
    return;
  }
  const brokenPresent = IMSG_CANDIDATE_PATHS.some((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (brokenPresent) {
    logger.warn('imsg CLI is INSTALLED BUT BROKEN everywhere it was found (crashes at launch, likely a ' +
      'missing PhoneNumberKit bundle). Sends fall back to AppleScript so delivery still works; repair for ' +
      'single-bubble captioned attachments: ' + IMSG_INSTALL_HINT);
  } else {
    logger.warn('imsg CLI not installed. Text and attachments both deliver via the AppleScript fallback; ' +
      'install imsg for single-bubble captioned attachments: ' + IMSG_INSTALL_HINT);
  }
}

/** What one send came to. `cut`: the owner's Stop ended it, and it may already have gone out. `caption-failed`: the file was delivered but its words were not. */
type SendResult = 'sent' | 'failed' | 'cut' | 'not-started' | 'caption-failed';
const STOP_DETAIL = {
  cut: "cut off by the owner's Stop (it may already have gone out)",
  // A send the standing Stop kept from starting certainly did not go out.
  'not-started': "not sent: the owner's Stop was already standing, so it never started",
} as const;
/** Was this send ended (or never begun) by the owner's Stop? Then nothing is retried another way. */
const byTheStop = (err: unknown): 'cut' | 'not-started' | null => (wasCutByTheStop(err) ? 'cut' : wasNeverStarted(err) ? 'not-started' : null);
const stopOrFail = (result: SendResult, failed: string): string => (result === 'cut' || result === 'not-started' ? STOP_DETAIL[result] : failed);

// ONE SEND AT A TIME, IN THE ORDER ASKED: two owner notices seconds apart must not reach the phone out of order.
// Every exported send takes its turn here; a send made INSIDE a send (an attachment's caption) runs in its parent's
// turn. Async work started inside a send inherits that marker and would skip the queue; no send path does that.
const inASend = new AsyncLocalStorage<true>();
let sendsInFlight = 0;
let lastSend: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(send: () => Promise<T>): Promise<T> {
  if (inASend.getStore()) return send();
  const start = (): Promise<T> => inASend.run(true, send);
  const run = sendsInFlight === 0 ? start() : lastSend.then(start);
  sendsInFlight++;
  lastSend = run.then(() => { sendsInFlight--; }, () => { sendsInFlight--; });
  return run;
}
/** An agent's own send (the `imessage_send` tool) names the agent, and is bound to that agent's Stop.
 *  A platform send (an owner notice, the auto-route) names nobody and no Stop cuts it. */
export interface SendOpts { agentId?: string }

// Returns true only if the send succeeded, so imessage_send callers never report "sent" for a failure.
export async function sendIMessage(recipient: string, rawText: string, opts: SendOpts = {}): Promise<boolean> {
  return (await oneAtATime(() => textDoor(recipient, rawText, opts))) === 'sent';
}

async function textDoor(recipient: string, rawText: string, opts: SendOpts): Promise<SendResult> {
  const result = await sendIMessageInner(recipient, rawText, opts);
  // THE DOOR RECORDS: every iMessage the platform sends passes through here (auto-route, imessage_send, alerts,
  // busy-ack, first-run welcome, the healer's approval prompt, the A2A relay's owner hand-back); the ledger
  // outcome comes from what the transport actually returned.
  recordedId(recordAtDoor({
    outcome: result === 'sent' ? 'delivered' : 'failed',
    channel: 'imessage',
    tool: 'imessage-door',
    recipientId: recipient,
    detail: result === 'sent' ? null : stopOrFail(result, 'every iMessage path failed (imsg CLI and AppleScript)'),
  }), 'imessage: door crossing', { to: recipientKind(recipient), ok: result === 'sent' });
  return result;
}

async function sendIMessageInner(recipient: string, rawText: string, opts: SendOpts): Promise<SendResult> {
  // Sanitize on ALL iMessage paths: strip markdown, literal \n and excess whitespace.
  const text = sanitizeForIMessage(rawText);

  try {
    const imsg = getImsgPath();
    let via: 'imsg' | 'applescript' = 'applescript';
    if (imsg) {
      try {
        // The text is a raw argument (argv, never a shell line): a shell would expand $100 into
        // a variable ("00") and pass JSON-escaped \n sequences literally instead of as newlines.
        await runMessagesProgram(imsg, ['send', '--to', recipient, '--text', text, '--service', 'imessage'], { timeout: 15000, agentId: opts.agentId });
        via = 'imsg';
      } catch (imsgErr) {
        // A Stop is not a broken imsg: nothing is retried another way.
        if (byTheStop(imsgErr)) throw imsgErr;
        // imsg is present but FAILED (e.g. a raw binary crashes with SIGTRAP when its PhoneNumberKit bundle did not
        // ship alongside): text does not need imsg, so fall back to AppleScript instead of dropping the message.
        logger.warn('imsg send failed, falling back to AppleScript', {
          to: recipientKind(recipient),
          error: imsgErr instanceof Error ? imsgErr.message : String(imsgErr),
        });
        await sendViaAppleScript(recipient, `send ${appleScriptString(text, true)}`, 10000, opts);
        via = 'applescript';
      }
    } else {
      await sendViaAppleScript(recipient, `send ${appleScriptString(text, true)}`, 10000, opts);
    }

    logger.info('iMessage sent', { to: recipientKind(recipient), textLength: text.length, via });
    // No `imessage:sent` broadcast: the dashboard sees delivery via the [SENT VIA IMESSAGE to <owner>] marker.
    return 'sent';
  } catch (err) {
    const stopped = byTheStop(err);
    if (stopped) { logger.info('iMessage send ended by the owner\'s Stop', { to: recipientKind(recipient), stopped }); return stopped; }
    logger.error('Failed to send iMessage', {
      error: err instanceof Error ? err.message : String(err),
      to: recipientKind(recipient),
    });
    return 'failed';
  }
}

/** iMessage tops out near 100MB per file: a larger one is refused before any send rather than left to time out. */
export const MAX_IMESSAGE_FILE_BYTES = 100 * 1024 * 1024;

/** Why a file cannot go by iMessage at all, checked before any send; null when it can be tried. */
export function iMessageFileRefusal(filePath: string): string | null {
  const size = fs.statSync(filePath, { throwIfNoEntry: false })?.size;
  return size === undefined ? 'not found' : size > MAX_IMESSAGE_FILE_BYTES ? 'over 100 MB' : null;
}

/** Sends one file with an optional caption (imsg, else AppleScript); true on success, false on any failure. */
export async function sendIMessageWithAttachment(recipient: string, filePath: string, caption?: string, opts: SendOpts = {}): Promise<boolean> {
  return (await oneAtATime(() => attachmentDoor(recipient, filePath, caption, opts))) === 'sent';
}

function attachmentDoor(recipient: string, filePath: string, caption: string | undefined, opts: SendOpts): Promise<SendResult> {
  // The attachment sends are doors too: each opens a scope when the caller declared none, so the file send and
  // the caption's nested `sendIMessage` fold into ONE row (one thing the person received); a caption that fails
  // after a delivered file makes that row honestly `failed`.
  return withOutboundAsyncIfAbsent(
    { agentId: PLATFORM_SENDER, tool: 'imessage-attachment-door', channel: 'imessage', recipientId: recipient },
    async () => {
      const result = await sendIMessageWithAttachmentInner(recipient, filePath, caption, opts);
      const file = `attachment ${path.basename(filePath)}`;
      recordedId(recordAtDoor({
        outcome: result === 'sent' ? 'delivered' : 'failed',
        channel: 'imessage',
        tool: 'imessage-attachment-door',
        recipientId: recipient,
        detail: result === 'sent' ? file
          : result === 'failed' ? `${file} failed on every path`
          : result === 'caption-failed' ? `${file} delivered but its caption failed`
          : `${file} ${STOP_DETAIL[result]}`,
      }), 'imessage: attachment door crossing', { to: recipientKind(recipient), ok: result === 'sent' });
      return result;
    },
  );
}

async function sendIMessageWithAttachmentInner(
  recipient: string,
  filePath: string,
  caption: string | undefined,
  opts: SendOpts,
): Promise<SendResult> {
  // Safe-sender revalidation: a sender removed from the allowlist mid-conversation must not still receive FILES
  // while their text reply is refused, as the reply sender's approved-list check does.
  if (!findSafeSenderByAddress(getSafeSenders(), recipient)) {
    logger.warn('Attachment send suppressed: recipient not on safe-sender list');
    return 'failed';
  }
  const imsg = getImsgPath();

  // Preferred path: imsg (single bubble, caption rides the file).
  if (imsg) {
    try {
      // The caption is cleaned like every other iMessage text; one that cleans to nothing sends the file bare.
      const cleanCaption = caption ? sanitizeForIMessage(caption) : '';
      const args = ['send', '--to', recipient];
      if (cleanCaption) args.push('--text', cleanCaption);
      args.push('--file', filePath, '--service', 'imessage');
      await runMessagesProgram(imsg, args, { timeout: 30000, agentId: opts.agentId });
      logger.info('iMessage attachment sent', { to: recipientKind(recipient), filePath, via: 'imsg', hasCaption: Boolean(cleanCaption) });
      return 'sent';
    } catch (err) {
      const stopped = byTheStop(err);
      if (stopped) return stopped;   // the owner stopped it: no AppleScript retry
      logger.warn('imsg attachment send failed, falling back to AppleScript file send. Repair imsg: ' + IMSG_INSTALL_HINT, {
        error: err instanceof Error ? err.message.slice(0, 300) : String(err),
        to: recipientKind(recipient),
        filePath,
      });
    }
  } else {
    logger.warn('imsg CLI not found, using AppleScript file send. For single-bubble captions install imsg: ' + IMSG_INSTALL_HINT);
  }

  // Fallback: AppleScript file send, for a broken or missing imsg. The file goes FIRST so a caption never
  // announces a file that failed; the caption then rides as its own bubble via sendIMessage.
  try {
    await sendViaAppleScript(recipient, `send POSIX file ${appleScriptString(filePath)}`, 15000, opts);
    logger.info('iMessage attachment sent', { to: recipientKind(recipient), filePath, via: 'applescript', hasCaption: Boolean(caption) });
    if (caption && caption.trim()) {
      const captionOk = await sendIMessage(recipient, caption, opts);
      if (!captionOk) {
        logger.warn('attachment caption send failed (the file itself was delivered)', { to: recipientKind(recipient), filePath });
        return 'caption-failed';
      }
    }
    return 'sent';
  } catch (err) {
    const stopped = byTheStop(err);
    if (stopped) return stopped;
    logger.error('iMessage attachment send failed on every path (imsg and AppleScript)', {
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
      to: recipientKind(recipient),
      filePath,
    });
    return 'failed';
  }
}

/** Sends a text plus files (the caption rides the first); returns { ok, sent, failed } for honest partial success. */
export function sendIMessageWithAttachments(
  recipient: string,
  text: string,
  filePaths: readonly string[],
  opts: SendOpts = {},
): Promise<{ ok: boolean; sentFiles: string[]; failedFiles: string[]; textSent: boolean }> {
  // One scope for the whole batch: a message with three files that partly failed is ONE delivery the person
  // half-received, recorded once and honestly as `failed`, not three rows or a green row per file that went through.
  return oneAtATime(() => withOutboundAsyncIfAbsent(
    { agentId: PLATFORM_SENDER, tool: 'imessage-attachment-door', channel: 'imessage', recipientId: recipient },
    () => sendIMessageWithAttachmentsInner(recipient, text, filePaths, opts),
  ));
}

async function sendIMessageWithAttachmentsInner(
  recipient: string,
  text: string,
  filePaths: readonly string[],
  opts: SendOpts,
): Promise<{ ok: boolean; sentFiles: string[]; failedFiles: string[]; textSent: boolean }> {
  if (filePaths.length === 0) {
    const ok = await sendIMessage(recipient, text, opts);
    return { ok, sentFiles: [], failedFiles: [], textSent: ok };
  }

  // Verify every file exists before sending: refusing up front beats a half-delivered message.
  for (const p of filePaths) {
    if (!fs.existsSync(p)) {
      logger.error('iMessage attachment file missing - aborting send', { path: p });
      return { ok: false, sentFiles: [], failedFiles: [p], textSent: false };
    }
  }

  // First file carries the caption; subsequent files go bare.
  const sentFiles: string[] = [];
  const failedFiles: string[] = [];
  let textSent = false;

  for (let i = 0; i < filePaths.length; i++) {
    const caption = i === 0 && text.trim() ? text : undefined;
    const result = await attachmentDoor(recipient, filePaths[i], caption, opts);
    if (result === 'sent') {
      sentFiles.push(filePaths[i]);
      if (i === 0 && caption) textSent = true;
    } else if (result === 'caption-failed') {
      // The file is delivered (never sent again); its words were not, so the final retry below sends them alone.
      sentFiles.push(filePaths[i]);
    } else if (result === 'cut' || result === 'not-started') {
      // The owner pressed Stop: nothing more goes out, not the next file and not the text alone.
      return { ok: false, sentFiles, failedFiles: [...failedFiles, ...filePaths.slice(i)], textSent };
    } else {
      failedFiles.push(filePaths[i]);
    }
  }

  // If the first file failed and its caption rode with nothing else, retry the text alone.
  if (!textSent && text.trim()) {
    const ok = await sendIMessage(recipient, text, opts);
    if (ok) textSent = true;
  }

  return { ok: failedFiles.length === 0, sentFiles, failedFiles, textSent };
}


/** The full safe-sender records (from config when the bridge is not running), parsed by parseSafeSenders. */
export function getSafeSenders(): SafeSender[] {
  if (approvedSenders.length > 0) return approvedSenders.map(s => ({ ...s }));
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
    return parseSafeSenders(row?.value ?? null);
  } catch {
    return [];
  }
}

/** Where owner notices go: the owner on iMessage, by the one rule in `./safe-senders.ts`. */
export function getDefaultSender(): string | null {
  return ownerIMessageRecord(getSafeSenders())?.address ?? null;
}

/** A WARN `owner-notice` entry records why a text did not reach the phone (Vitals log view). */
const ownerNoticeLog = createLogger('owner-notice');

/**
 * THE OWNER'S PHONE DOOR, where the PLATFORM, not an agent, texts the owner. `critical` (prefixed "[CRITICAL]") and
 * `notice` go to the phone; `warning` and `info` do not. Its dashboard card is the caller's, through the one writer
 * (`healer/owner-notices.ts tellOwner`). The texts are exactly these kinds (offline, back online and a failed
 * integrity check are the watchdog's); a text outside the set does not type-check and is refused here.
 */
export const PLATFORM_TEXT_KINDS = ['budget', 'broken-agent', 'mac-critical', 'remote-address'] as const;
export type PlatformTextKind = typeof PLATFORM_TEXT_KINDS[number];

export async function sendAlert(message: string, urgency: 'info' | 'warning' | 'critical' | 'notice', opts: { kind: PlatformTextKind; agentId?: string }): Promise<void> {
  try {
    if (!(PLATFORM_TEXT_KINDS as readonly string[]).includes(opts.kind)) {
      logger.warn('Alert refused: not one of the owner\'s platform texts', { kind: opts.kind });
      return;
    }
    const scrubbed = scrubTechnicalDetail(message);

    if (urgency !== 'critical' && urgency !== 'notice') {
      logger.info('Alert suppressed from iMessage (non-critical/non-notice)', {
        urgency,
        message: scrubbed.slice(0, 200),
      });
      return;
    }

    const fullMessage = dojoVoice(urgency === 'critical' ? `[CRITICAL] ${scrubbed}` : scrubbed);   // "Dojo:" first; the card keeps the bare words
    logger.info(`Sending ${urgency} alert to iMessage`, { message: scrubbed.slice(0, 200) });

    const recipient = getDefaultSender();
    // An alert reaches a real person's phone: it is a PLATFORM outbound, not an agent's, so the door opens its OWN
    // scope (never the `IfAbsent` form, which would fold a notice fired inside an agent's send into that send's row).
    const sent = recipient !== null && await withOutboundAsync(
      { agentId: PLATFORM_SENDER, tool: 'alert', channel: 'imessage', recipientId: recipient },
      async () => {
        const ok = await sendIMessage(recipient, fullMessage);
        return tellAgentOwnerAlertSent(opts.agentId, fullMessage, ok);   // the agent is told what went out
      },
    );
    if (!sent) ownerNoticeLog.warn(scrubbed, { urgency, phone: recipient ? 'the phone send failed' : 'no phone channel set up' });
  } catch (err) {
    logger.error('Failed to send alert', {
      error: err instanceof Error ? err.message : String(err),
      urgency,
    });
  }
}

/** iMessage is switched on unless the owner switched it off in Settings (`imessage_enabled` is 'false'). The Dojo's own alerts do not ask it. */
export function isIMessageSwitchedOn(): boolean {
  try {
    return (getDb().prepare("SELECT value FROM config WHERE key = 'imessage_enabled'").get() as { value: string } | undefined)?.value !== 'false';
  } catch {
    return true;
  }
}

export function isIMBridgeRunning(): boolean {
  return pollTimer !== null;
}

export function getIMBridgeStatus(): {
  running: boolean;
  enabled: boolean;
  connected: boolean;
  approvedSenders: string[];
  safeSenders: SafeSender[];
  lastSeenRowId: number;
} {
  const running = pollTimer !== null;
  const records = getSafeSenders();
  const hasSenders = records.length > 0;
  return {
    running,
    enabled: hasSenders || running,
    connected: running,
    approvedSenders: records.map(s => s.address),
    safeSenders: records,
    lastSeenRowId,
  };
}
