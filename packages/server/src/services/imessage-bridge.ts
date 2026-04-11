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

function fetchImessageAttachments(
  chatDb: Database.Database,
  messageRowid: number,
  agentId: string,
): UploadedFile[] {
  const rows = chatDb.prepare(`
    SELECT a.ROWID, a.filename, a.mime_type, a.transfer_name
    FROM message_attachment_join maj
    JOIN attachment a ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = ?
    ORDER BY a.ROWID ASC
  `).all(messageRowid) as IMessageAttachmentRow[];

  if (rows.length === 0) return [];

  const dir = ensureImessageUploadDir(agentId);
  const uploaded: UploadedFile[] = [];

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
    const fileId = uuidv4();
    const timestamp = Date.now();

    try {
      if (IMAGE_MIMES.has(mimeType)) {
        const storedName = `imessage_${timestamp}_${safeFilenamePart(displayName)}`;
        const destPath = path.join(dir, storedName);
        fs.copyFileSync(srcPath, destPath);
        const size = fs.statSync(destPath).size;
        uploaded.push({
          fileId, filename: displayName, mimeType, size, path: destPath, category: 'image',
        });
        logger.info('iMessage image attached', { fileId, displayName, size });
      } else if (HEIC_MIMES.has(mimeType)) {
        // Vision models don't accept HEIC — convert to JPEG via macOS's
        // built-in `sips` tool. 30s timeout should be generous for any
        // reasonable iPhone photo.
        const jpegBase = safeFilenamePart(displayName).replace(/\.(heic|heif)$/i, '.jpg');
        const jpegName = `imessage_${timestamp}_${jpegBase}`;
        const destPath = path.join(dir, jpegName);
        execSync(
          `sips -s format jpeg ${JSON.stringify(srcPath)} --out ${JSON.stringify(destPath)}`,
          { stdio: 'pipe', timeout: 30_000 },
        );
        if (!fs.existsSync(destPath)) {
          logger.warn('HEIC conversion produced no output — skipping', { srcPath, destPath });
          continue;
        }
        const size = fs.statSync(destPath).size;
        uploaded.push({
          fileId,
          filename: displayName.replace(/\.(heic|heif)$/i, '.jpg'),
          mimeType: 'image/jpeg',
          size,
          path: destPath,
          category: 'image',
        });
        logger.info('iMessage HEIC converted and attached', { fileId, displayName, size });
      } else if (PDF_MIMES.has(mimeType)) {
        const storedName = `imessage_${timestamp}_${safeFilenamePart(displayName)}`;
        const destPath = path.join(dir, storedName);
        fs.copyFileSync(srcPath, destPath);
        const size = fs.statSync(destPath).size;
        uploaded.push({
          fileId, filename: displayName, mimeType, size, path: destPath, category: 'pdf',
        });
        logger.info('iMessage PDF attached', { fileId, displayName, size });
      } else {
        logger.info('iMessage attachment type unsupported — skipping', {
          displayName, mimeType,
        });
      }
    } catch (err) {
      logger.warn('Failed to copy/convert iMessage attachment — skipping', {
        displayName,
        mimeType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return uploaded;
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
        SELECT m.ROWID, m.text, m.is_from_me, m.date, c.chat_identifier
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
        chat_identifier: string;
      }>;

      for (const msg of messages) {
        lastSeenRowId = msg.ROWID;
        saveLastSeenRowId(lastSeenRowId);

        const sender = msg.chat_identifier;
        const primaryId = getPrimaryAgentId();

        // Sanitize text: strip U+FFFC attachment placeholders so we don't
        // forward control characters to the model.
        const cleanedText = stripAttachmentPlaceholder(msg.text);

        // Pull any attachments (images/PDFs) linked to this message into the
        // dojo uploads dir. Unsupported types get skipped with a log.
        const attachments = fetchImessageAttachments(chatDb, msg.ROWID, primaryId);

        // Skip rows that are neither text nor a supported attachment —
        // these are reactions, typing indicators, or unsupported media.
        if (!cleanedText && attachments.length === 0) {
          logger.debug('iMessage skipped — no text and no supported attachments', {
            rowid: msg.ROWID,
          });
          continue;
        }

        logger.info('iMessage received', {
          from: sender,
          text: cleanedText.slice(0, 100),
          attachmentCount: attachments.length,
        });

        broadcast({
          type: 'imessage:received',
          data: {
            text: cleanedText,
            from: sender,
            timestamp: new Date().toISOString(),
            attachmentCount: attachments.length,
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

          // Build a clear text body for the model. When the user sends an
          // image with no caption the caption is empty; we note explicitly
          // that attachments are present so the model's reasoning is anchored.
          const textForModel = cleanedText
            ? cleanedText
            : (attachments.length === 1
                ? '(attached without a caption)'
                : `(${attachments.length} files attached without a caption)`);
          const msgContent = `[SOURCE: IMESSAGE FROM ${ownerName.toUpperCase()} — this message came from iMessage, not the dashboard chat] ${textForModel}`;

          db.prepare(`
            INSERT INTO messages (id, agent_id, role, content, attachments, created_at)
            VALUES (?, ?, 'user', ?, ?, datetime('now'))
          `).run(
            msgId,
            primaryId,
            msgContent,
            attachments.length > 0 ? JSON.stringify(attachments) : null,
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

export function sendIMessage(recipient: string, text: string): void {
  try {
    // Escape single quotes and backslashes for AppleScript
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
