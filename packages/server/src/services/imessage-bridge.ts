// ════════════════════════════════════════
// iMessage Bridge: Polling + Sending
// ════════════════════════════════════════

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId, getOwnerName } from '../config/platform.js';
import { handleIMCommand } from './imessage-commands.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';

// ── iMessage attachment pipeline ────────────────────────────────────────────
//
// macOS's Messages chat.db stores a row in `message_attachment_join` for each
// file attached to a message, and the `attachment` table has the actual path
// (in `~/Library/Messages/Attachments/...`), MIME type, and original name.
// When a user sends an image or PDF to the primary agent via iMessage, we:
//
//   1. Fetch the attachment rows linked to the message.
//   2. Copy each supported file into `~/.dojo/uploads/<agentId>/` using the
//      same directory layout as dashboard uploads.
//   3. Convert HEIC → JPEG via macOS's built-in `sips` (vision models don't
//      accept HEIC).
//   4. Register them as an `UploadedFile[]` which gets JSON-serialized into
//      the `messages.attachments` column — identical shape to what the
//      /upload route writes, so the runtime's `injectAttachmentBlocks`
//      picks them up automatically.
//
// Unsupported attachment types (video, audio, arbitrary docs) are logged and
// skipped. The forwarded text is sanitized to remove the `￼` object-
// replacement character macOS inserts as a placeholder for attachments.

interface IMessageAttachmentRow {
  ROWID: number;
  filename: string | null;
  mime_type: string | null;
  transfer_name: string | null;
}

// Mirror of upload.ts UploadedFile — same shape so the runtime's attachment
// injection logic can read both without any branching.
interface UploadedFile {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: 'image' | 'pdf' | 'text' | 'office' | 'unknown';
}

const DOJO_UPLOAD_DIR = path.join(os.homedir(), '.dojo', 'uploads');
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const HEIC_MIMES = new Set(['image/heic', 'image/heif']);
const PDF_MIMES = new Set(['application/pdf']);

// ── Attachment-readiness race ────────────────────────────────────────────
//
// When macOS receives an iMessage with an attachment, chat.db gets the
// message row and attachment row written immediately, but the actual
// attachment file under ~/Library/Messages/Attachments/... may take
// several seconds to appear — especially for large photos, HEIC from an
// iPhone, or anything being synced from iCloud. If we poll during that
// window and advance `lastSeenRowId` past the message, we'll process it
// as text-only and never retry. The model then says "I don't see an
// image attached" because, from its perspective, there never was one.
//
// Fix: before advancing past any message that claims attachments, verify
// every attachment file is actually on disk. If not, break out of the
// processing loop without advancing, and try again on the next poll.
// A per-rowid retry counter bounds the deferral so a permanently broken
// download doesn't block the bridge forever — after ~60 seconds of
// retries (12 polls × 5s interval) we give up and process the message
// without the attachments, logging a warning so the reason is visible.

const MAX_ATTACHMENT_RETRIES = 12;
const deferredAttachmentRetries = new Map<number, number>();

// Text-ish file extensions we'll read + inline directly into the forwarded
// message body (same list as packages/server/src/gateway/routes/upload.ts).
// Any file under `INLINE_TEXT_MAX_BYTES` whose MIME starts with `text/` or
// whose extension is in this set gets slurped and framed with a header/
// footer so the model reads it as context. Duplicated here rather than
// imported to keep the iMessage bridge self-contained.
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

// A note about an attachment we chose not to decode/deliver — still surfaced
// to the model in the message text so it can respond "I got your video but
// I can't play videos" etc, rather than silently dropping the context.
interface MentionedAttachment {
  name: string;
  mimeType: string;
  size: number;
  reason: string; // short human-readable reason for the mention-only path
}

interface ImessageAttachmentResult {
  uploadedFiles: UploadedFile[];   // image/PDF copied to disk, runtime injects as content blocks
  inlinedTextBlocks: string[];     // small text files read + framed for the message body
  mentionedAttachments: MentionedAttachment[]; // everything else — metadata only
}

function ensureImessageUploadDir(agentId: string): string {
  const dir = path.join(DOJO_UPLOAD_DIR, agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function expandHomedir(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

function safeFilenamePart(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Remove the U+FFFC object-replacement character macOS inserts in the text
// column for each inline attachment, plus any leftover whitespace. If the
// user sent an image with no caption, this collapses to an empty string.
function stripAttachmentPlaceholder(text: string | null): string {
  return (text ?? '').replace(/\uFFFC/g, '').trim();
}

// Quickly checks whether every attachment linked to a given message has
// its file on disk. Read-only, no side effects — just a sanity probe the
// poll loop uses to decide whether to defer processing.
//
// Returns `{ready: true}` when the message has zero attached files OR
// every attachment's `filename` path exists on disk. Returns
// `{ready: false, reason}` as soon as one is missing.
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

  // No joins yet → either the message has no attachments, or the join
  // row hasn't been written yet. In the first case we're fine; in the
  // second, the message's text was already processed one poll earlier
  // before the join existed, so there's nothing we can do now. Treat
  // "no joins" as ready and move on.
  if (rows.length === 0) return { ready: true };

  for (const row of rows) {
    if (!row.filename) continue; // attachment row exists but no path — skip it silently
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

function fetchImessageAttachments(
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
      logger.warn('iMessage attachment file missing on disk — skipping', {
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

    // Stat once up front so every branch has size info without re-stating.
    let srcSize = 0;
    try { srcSize = fs.statSync(srcPath).size; } catch { /* leave 0 */ }

    try {
      // ── Tier 1: deliverable bytes (image + PDF) ──────────────────────
      if (IMAGE_MIMES.has(mimeType)) {
        const storedName = `imessage_${timestamp}_${safeFilenamePart(displayName)}`;
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
        // Vision models don't accept HEIC — convert to JPEG via macOS's
        // built-in `sips` tool. 30s timeout is generous for any iPhone photo.
        const jpegBase = safeFilenamePart(displayName).replace(/\.(heic|heif)$/i, '.jpg');
        const jpegName = `imessage_${timestamp}_${jpegBase}`;
        const destPath = path.join(dir, jpegName);
        execSync(
          `sips -s format jpeg ${JSON.stringify(srcPath)} --out ${JSON.stringify(destPath)}`,
          { stdio: 'pipe', timeout: 30_000 },
        );
        if (!fs.existsSync(destPath)) {
          logger.warn('HEIC conversion produced no output — mentioning instead', {
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
        const storedName = `imessage_${timestamp}_${safeFilenamePart(displayName)}`;
        const destPath = path.join(dir, storedName);
        fs.copyFileSync(srcPath, destPath);
        const size = fs.statSync(destPath).size;
        result.uploadedFiles.push({
          fileId, filename: displayName, mimeType, size, path: destPath, category: 'pdf',
        });
        logger.info('iMessage PDF attached', { fileId, displayName, size });
        continue;
      }

      // ── Tier 2: inline text (small text-ish files read + framed) ─────
      const looksLikeText = mimeType.startsWith('text/') || INLINE_TEXT_EXTENSIONS.has(ext);
      if (looksLikeText) {
        if (srcSize > INLINE_TEXT_MAX_BYTES) {
          result.mentionedAttachments.push({
            name: displayName,
            mimeType: mimeType || `text/${ext.slice(1) || 'plain'}`,
            size: srcSize,
            reason: `text file too large to inline (${formatBytes(srcSize)}, cap ${formatBytes(INLINE_TEXT_MAX_BYTES)})`,
          });
          logger.info('iMessage text file too large — mentioning', { displayName, size: srcSize });
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

      // ── Tier 3: mention only (video, audio, office, unknown) ─────────
      // We don't copy the bytes. The model gets the filename, MIME type,
      // and size in the message body and can decide how to respond.
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
      logger.warn('Failed to process iMessage attachment — mentioning instead', {
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

const logger = createLogger('imessage');

let pollTimer: ReturnType<typeof setInterval> | null = null;
let approvedSenders: string[] = [];
let lastSeenRowId = 0;
const POLL_INTERVAL_MS = 5000;

// Track which sender triggered each agent's current turn so we reply to the right person.
// No timeout — the flag stays until the agent's response is sent. Slow turns (tool calls,
// slow models) should still get their iMessage reply.
const pendingIMResponseMap = new Map<string, { sender: string }>(); // agentId -> sender

export function isAwaitingIMResponse(agentId: string): boolean {
  return pendingIMResponseMap.has(agentId);
}

export function clearIMResponseFlag(agentId: string): void {
  pendingIMResponseMap.delete(agentId);
}

export function sendResponseViaIMessage(text: string, agentId?: string): void {
  if (!agentId) agentId = getPrimaryAgentId();
  const entry = pendingIMResponseMap.get(agentId);
  const sender = entry?.sender ?? approvedSenders[0];
  if (sender) {
    sendIMessage(sender, text);
  }
  pendingIMResponseMap.delete(agentId);
}
const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

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

async function pollMessages(): Promise<void> {
  if (approvedSenders.length === 0) return;

  try {
    // Open the Messages database read-only
    const chatDb = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });

    try {
      // Build a query that matches ANY approved sender. No text filter —
      // image-only messages store U+FFFC in `text` and we want them through.
      const placeholders = approvedSenders.map(() => 'c.chat_identifier LIKE ?').join(' OR ');
      const likeParams = approvedSenders.map(s => `%${s}%`);

      const messages = chatDb.prepare(`
        SELECT m.ROWID, m.text, m.is_from_me, m.date, m.cache_has_attachments, c.chat_identifier
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE m.ROWID > ?
          AND m.is_from_me = 0
          AND (${placeholders})
        ORDER BY m.ROWID ASC
        LIMIT 10
      `).all(lastSeenRowId, ...likeParams) as Array<{
        ROWID: number;
        text: string | null;
        is_from_me: number;
        date: number;
        cache_has_attachments: number;
        chat_identifier: string;
      }>;

      for (const msg of messages) {
        // ── Attachment-readiness gate ──
        // If chat.db claims this message has attachments but the files
        // aren't on disk yet (iCloud sync, slow download, etc.), defer
        // processing by breaking out of this poll cycle WITHOUT
        // advancing lastSeenRowId. The next poll will see the same
        // message again and retry. Bounded by MAX_ATTACHMENT_RETRIES so
        // a permanently-missing file can't block the bridge forever.
        if (msg.cache_has_attachments === 1) {
          const readiness = isMessageAttachmentReady(chatDb, msg.ROWID);
          if (!readiness.ready) {
            const retries = (deferredAttachmentRetries.get(msg.ROWID) ?? 0) + 1;
            if (retries < MAX_ATTACHMENT_RETRIES) {
              deferredAttachmentRetries.set(msg.ROWID, retries);
              logger.info('iMessage attachment not ready — deferring to next poll', {
                rowid: msg.ROWID,
                retry: retries,
                maxRetries: MAX_ATTACHMENT_RETRIES,
                reason: readiness.reason,
              });
              break; // stop processing this cycle, do NOT advance lastSeenRowId
            }
            // Give up and process the message without attachments so the
            // bridge doesn't get permanently stuck on a broken download.
            logger.warn('iMessage attachment never became ready — processing without it', {
              rowid: msg.ROWID,
              retriesAttempted: retries,
              reason: readiness.reason,
            });
            deferredAttachmentRetries.delete(msg.ROWID);
          }
        }

        lastSeenRowId = msg.ROWID;
        saveLastSeenRowId(lastSeenRowId);
        deferredAttachmentRetries.delete(msg.ROWID); // clear any prior retry count

        const sender = msg.chat_identifier;
        const primaryId = getPrimaryAgentId();

        // Sanitize text: strip U+FFFC attachment placeholders so we don't
        // forward control characters to the model.
        const cleanedText = stripAttachmentPlaceholder(msg.text);

        // Pull every attachment linked to this message. The helper classifies
        // each into one of three buckets: deliverable bytes (image/PDF,
        // copied to uploads dir), inlined text (small text files read into
        // memory), or mention-only metadata (video/audio/office/unknown —
        // the model is told they exist so it can decide how to respond).
        const attachmentResult = fetchImessageAttachments(chatDb, msg.ROWID, primaryId);
        const totalAttachmentCount =
          attachmentResult.uploadedFiles.length +
          attachmentResult.inlinedTextBlocks.length +
          attachmentResult.mentionedAttachments.length;

        // Skip rows that are neither text nor any kind of attachment —
        // these are reactions, typing indicators, etc.
        if (!cleanedText && totalAttachmentCount === 0) {
          logger.debug('iMessage skipped — no text and no attachments of any kind', {
            rowid: msg.ROWID,
          });
          continue;
        }

        logger.info('iMessage received', {
          from: sender,
          text: cleanedText.slice(0, 100),
          uploaded: attachmentResult.uploadedFiles.length,
          inlined: attachmentResult.inlinedTextBlocks.length,
          mentioned: attachmentResult.mentionedAttachments.length,
        });

        broadcast({
          type: 'imessage:received',
          data: {
            text: cleanedText,
            from: sender,
            timestamp: new Date().toISOString(),
            attachmentCount: totalAttachmentCount,
          },
        } as never);

        // Check for built-in commands against the text portion only (an
        // image-only message can't be a command). Reply goes to the sender.
        if (cleanedText) {
          const commandResponse = await handleIMCommand(cleanedText, sender);
          if (commandResponse) {
            sendIMessage(sender, commandResponse);
            continue;
          }
        }

        // Forward to primary agent's runtime as a user message
        try {
          const db = getDb();
          const ownerName = getOwnerName();
          const msgId = uuidv4();

          // ── Compose the forwarded message body ─────────────────────
          // Three pieces, any of which may be empty:
          //   1. The user's typed caption (if any)
          //   2. Inlined text files (framed blocks ready for the model)
          //   3. A "[Other attachments ...]" footer listing everything we
          //      didn't deliver as bytes or inline text — gives the model
          //      enough info to say "I can't play that video" or similar.
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

          if (attachmentResult.mentionedAttachments.length > 0) {
            const lines = attachmentResult.mentionedAttachments.map(m =>
              `  • ${m.name} (${m.mimeType}, ${formatBytes(m.size)}) — ${m.reason}`,
            );
            bodyParts.push(
              `[Other attachments this model can't directly process — let ${ownerName} know if the format isn't supported]:\n${lines.join('\n')}`,
            );
          }

          const textForModel = bodyParts.join('\n\n');
          const msgContent = `[SOURCE: IMESSAGE FROM ${ownerName.toUpperCase()} — this message came from iMessage, not the dashboard chat] ${textForModel}`;

          db.prepare(`
            INSERT INTO messages (id, agent_id, role, content, attachments, created_at)
            VALUES (?, ?, 'user', ?, ?, datetime('now'))
          `).run(
            msgId,
            primaryId,
            msgContent,
            attachmentResult.uploadedFiles.length > 0 ? JSON.stringify(attachmentResult.uploadedFiles) : null,
          );

          broadcast({
            type: 'chat:message',
            agentId: primaryId,
            message: {
              id: msgId,
              agentId: primaryId,
              role: 'user' as const,
              content: msgContent,
              tokenCount: null,
              modelId: null,
              cost: null,
              latencyMs: null,
              createdAt: new Date().toISOString(),
              // Include the uploaded attachments in the WS payload so the
              // dashboard can render thumbnails the moment the iMessage
              // arrives, without waiting for a page refresh to re-fetch.
              ...(attachmentResult.uploadedFiles.length > 0
                ? { attachments: attachmentResult.uploadedFiles }
                : {}),
            },
          });

          // Flag that primary agent's next response should be sent back via iMessage to this sender
          pendingIMResponseMap.set(primaryId, { sender });

          const runtime = getAgentRuntime();
          runtime.handleMessage(primaryId, msgContent).catch(err => {
            logger.error('Failed to process iMessage in runtime', {
              error: err instanceof Error ? err.message : String(err),
            });
            pendingIMResponseMap.delete(primaryId);
          });
        } catch (err) {
          logger.error('Failed to inject iMessage to primary agent', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
  }
}

export function startIMBridge(recipientId: string): void {
  if (pollTimer) {
    logger.warn('iMessage bridge already running');
    return;
  }

  // Load approved senders from config, falling back to legacy single recipient
  const db = getDb();
  const sendersRow = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
  if (sendersRow?.value) {
    try {
      const parsed = JSON.parse(sendersRow.value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        approvedSenders = parsed;
      } else {
        approvedSenders = [recipientId];
      }
    } catch {
      approvedSenders = [recipientId];
    }
  } else {
    approvedSenders = [recipientId];
  }

  lastSeenRowId = loadLastSeenRowId();

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
      // If we can't read chat.db, leave at 0 — pollMessages will handle the error gracefully
      logger.warn('Could not seed lastSeenRowId from Messages DB', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Starting iMessage bridge', { approvedSenders, lastSeenRowId });

  // Start polling
  pollTimer = setInterval(() => {
    pollMessages().catch(err => {
      logger.error('iMessage poll cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  // Initial poll
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

// ── Text messages: AppleScript (works everywhere) ─────────────────────

export function sendIMessage(recipient: string, text: string): void {
  try {
    const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedRecipient = recipient.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
      tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy "${escapedRecipient}" of targetService
        send "${escapedText}" to targetBuddy
      end tell
    `;

    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      timeout: 10000,
      encoding: 'utf-8',
    });

    logger.info('iMessage sent', { recipient, textLength: text.length });

    broadcast({
      type: 'imessage:sent',
      data: {
        to: recipient,
        text: text.slice(0, 200),
        timestamp: new Date().toISOString(),
      },
    } as never);
  } catch (err) {
    logger.error('Failed to send iMessage', {
      error: err instanceof Error ? err.message : String(err),
      recipient,
    });
  }
}

// ── File attachments: imsg CLI (AppleScript can't do this reliably) ───
//
// AppleScript's `send POSIX file` silently fails on newer macOS versions
// (-1700: "Can't make POSIX file into type file or text"). The `imsg`
// CLI tool (github.com/steipete/imsg) handles file delivery properly.
// It's only used for attachments — plain text continues to use the
// proven AppleScript path above.
//
// If imsg isn't installed, falls back to sending a text-only message
// pointing the user to the dashboard.

function findImsg(): string | null {
  for (const p of ['/opt/homebrew/bin/imsg', '/usr/local/bin/imsg']) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* continue */ }
  }
  // Check PATH as last resort
  try {
    execSync('which imsg', { encoding: 'utf-8', stdio: 'pipe' });
    return 'imsg';
  } catch {
    return null;
  }
}

let imsgPathCached: string | null | undefined = undefined;
function getImsgPath(): string | null {
  if (imsgPathCached === undefined) imsgPathCached = findImsg();
  return imsgPathCached;
}

/**
 * Send a file attachment via iMessage with an optional text caption.
 * Uses the `imsg` CLI for the file attachment since AppleScript can't
 * handle POSIX file sends on newer macOS. If imsg isn't installed,
 * sends the caption as text and tells the user to check the dashboard.
 */
export function sendIMessageWithAttachment(
  recipient: string,
  filePath: string,
  caption?: string,
): void {
  const imsg = getImsgPath();

  if (!imsg) {
    logger.warn('imsg CLI not found — cannot send iMessage attachment. Install from https://github.com/steipete/imsg');
    if (caption) sendIMessage(recipient, caption);
    sendIMessage(recipient, '(Image generated but imsg CLI not installed — open the dashboard to see it.)');
    return;
  }

  try {
    const textArg = caption ? ` --text ${JSON.stringify(caption)}` : '';
    execSync(
      `${imsg} send --to ${JSON.stringify(recipient)}${textArg} --file ${JSON.stringify(filePath)} --service imessage`,
      { timeout: 30000, encoding: 'utf-8', stdio: 'pipe' },
    );

    logger.info('iMessage attachment sent via imsg', { recipient, filePath });

    broadcast({
      type: 'imessage:sent',
      data: {
        to: recipient,
        text: `[attachment: ${filePath}]`,
        timestamp: new Date().toISOString(),
      },
    } as never);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('imsg send failed — falling back to text', {
      error: errMsg,
      recipient,
      filePath,
    });

    // Fallback: send caption + dashboard pointer via AppleScript
    try {
      if (caption) sendIMessage(recipient, caption);
      sendIMessage(recipient, '(The image was generated but couldn\'t be attached — open the dashboard to see it.)');
    } catch { /* double-fault — give up */ }
  }
}

// ── Alert & Sender Helpers ──

export function getDefaultSender(): string | null {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM config WHERE key = 'imessage_default_sender'`).get() as { value: string } | undefined;
    if (row?.value) return row.value;
  } catch {
    // Fall through to approvedSenders fallback
  }

  // Fallback: if bridge is running, use in-memory list; otherwise load from config
  if (approvedSenders.length > 0) return approvedSenders[0];

  try {
    const db = getDb();
    const sendersRow = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
    if (sendersRow?.value) {
      const parsed = JSON.parse(sendersRow.value);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
    }
  } catch {
    // No senders available
  }

  return null;
}

export function getApprovedSenders(): string[] {
  if (approvedSenders.length > 0) return [...approvedSenders];

  try {
    const db = getDb();
    const sendersRow = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
    if (sendersRow?.value) {
      const parsed = JSON.parse(sendersRow.value);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // No senders available
  }

  return [];
}

export function sendAlert(message: string, urgency: 'info' | 'warning' | 'critical'): void {
  try {
    const prefix = urgency === 'critical' ? '[CRITICAL]' : urgency === 'warning' ? '[WARNING]' : '[INFO]';
    const fullMessage = `${prefix} ${message}`;

    logger.info('Sending alert', { urgency, message: message.slice(0, 200) });

    // Always send to default sender only
    const recipient = getDefaultSender();
    if (!recipient) {
      logger.warn('Cannot send alert: no default sender configured');
      return;
    }
    sendIMessage(recipient, fullMessage);
  } catch (err) {
    logger.error('Failed to send alert', {
      error: err instanceof Error ? err.message : String(err),
      urgency,
    });
  }
}

export function isIMBridgeRunning(): boolean {
  return pollTimer !== null;
}

export function getIMBridgeStatus(): { running: boolean; enabled: boolean; connected: boolean; approvedSenders: string[]; lastSeenRowId: number } {
  const running = pollTimer !== null;
  // "enabled" = senders are configured (bridge can be started)
  const hasSenders = approvedSenders.length > 0 || getApprovedSenders().length > 0;
  return {
    running,
    enabled: hasSenders || running,
    connected: running,
    approvedSenders: approvedSenders.length > 0 ? approvedSenders : getApprovedSenders(),
    lastSeenRowId,
  };
}
