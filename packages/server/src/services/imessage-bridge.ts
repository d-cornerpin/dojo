// ════════════════════════════════════════
// iMessage Bridge: Polling + Sending
// ════════════════════════════════════════

import { execSync } from 'node:child_process';
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

const logger = createLogger('imessage');

let pollTimer: ReturnType<typeof setInterval> | null = null;
let approvedSenders: string[] = [];
let lastSeenRowId = 0;
const POLL_INTERVAL_MS = 5000;

// Track which sender triggered each agent's current turn so we reply to the right person
// Entries expire after 60 seconds to prevent stale flags from sending unexpected iMessages
const pendingIMResponseMap = new Map<string, { sender: string; setAt: number }>(); // agentId -> { sender, timestamp }

const IM_RESPONSE_TIMEOUT_MS = 60000; // 60 seconds — flags expire to prevent stale replies

export function isAwaitingIMResponse(agentId: string): boolean {
  const entry = pendingIMResponseMap.get(agentId);
  if (!entry) return false;
  // Expire stale flags
  if (Date.now() - entry.setAt > IM_RESPONSE_TIMEOUT_MS) {
    pendingIMResponseMap.delete(agentId);
    return false;
  }
  return true;
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
      // Build a query that matches ANY approved sender
      const placeholders = approvedSenders.map(() => 'c.chat_identifier LIKE ?').join(' OR ');
      const likeParams = approvedSenders.map(s => `%${s}%`);

      const messages = chatDb.prepare(`
        SELECT m.ROWID, m.text, m.is_from_me, m.date, c.chat_identifier
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE m.ROWID > ?
          AND m.is_from_me = 0
          AND m.text IS NOT NULL
          AND m.text != ''
          AND (${placeholders})
        ORDER BY m.ROWID ASC
        LIMIT 10
      `).all(lastSeenRowId, ...likeParams) as Array<{
        ROWID: number;
        text: string;
        is_from_me: number;
        date: number;
        chat_identifier: string;
      }>;

      for (const msg of messages) {
        lastSeenRowId = msg.ROWID;
        saveLastSeenRowId(lastSeenRowId);

        const sender = msg.chat_identifier;
        logger.info('iMessage received', { from: sender, text: msg.text.slice(0, 100) });

        broadcast({
          type: 'imessage:received',
          data: {
            text: msg.text,
            from: sender,
            timestamp: new Date().toISOString(),
          },
        } as never);

        // Check for built-in commands — reply goes to the sender
        const commandResponse = await handleIMCommand(msg.text, sender);
        if (commandResponse) {
          sendIMessage(sender, commandResponse);
          continue;
        }

        // Forward to primary agent's runtime as a user message
        try {
          const db = getDb();
          const primaryId = getPrimaryAgentId();
          const ownerName = getOwnerName();
          const msgId = uuidv4();
          const msgContent = `[iMessage from ${ownerName}] ${msg.text}`;
          db.prepare(`
            INSERT INTO messages (id, agent_id, role, content, created_at)
            VALUES (?, ?, 'user', ?, datetime('now'))
          `).run(msgId, primaryId, msgContent);

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
          pendingIMResponseMap.set(primaryId, { sender, setAt: Date.now() });

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
