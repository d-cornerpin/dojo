// ════════════════════════════════════════
// A2A Transport — Structured Agent-to-Agent Message Delivery
//
// Central delivery function for all inter-agent messages. Enforces:
//   - Terminal-thread gating (closed threads reject non-reopening intents)
//   - Hop counting (max 8 delivered messages per thread)
//   - Semantic deduplication (cosine similarity > 0.85 against last 3)
//   - requires_response routing (false = no receiver generation)
//
// All inter-agent communication — send_to_agent, PM pokes, healer
// alerts, completion notifications — flows through deliverA2AMessage.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from './runtime.js';
// A2A protocol constants and helpers — inlined here to avoid runtime
// imports from @dojo/shared (which points at .ts source and can't be
// loaded by Node.js in production without a TS loader).
// Types are still imported from @dojo/shared as type-only (erased at compile time).
import type { A2AIntent, A2AEnvelope, A2ADropReason } from '@dojo/shared';

const TERMINAL_INTENTS = new Set<A2AIntent>(['DELIVERABLE', 'FYI', 'COMPLETE', 'FAIL', 'ANSWER']);
const REOPENING_INTENTS = new Set<A2AIntent>(['QUESTION', 'BLOCK', 'ASSIGN']);
const MAX_HOPS_PER_THREAD = 8;
const DEDUP_SIMILARITY_THRESHOLD = 0.85;
const DEDUP_LOOKBACK = 3;

function isTerminalIntent(intent: A2AIntent): boolean { return TERMINAL_INTENTS.has(intent); }
function isReopeningIntent(intent: A2AIntent): boolean { return REOPENING_INTENTS.has(intent); }

// Re-export for callers that need these (tools.ts)
export { isTerminalIntent, isReopeningIntent, type A2AIntent };

const logger = createLogger('a2a-transport');

// ── Thread State Management ──

function ensureThread(threadId: string, senderId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO a2a_threads (thread_id, hop_count, last_sender, created_at, updated_at)
    VALUES (?, 0, ?, datetime('now'), datetime('now'))
  `).run(threadId, senderId);
}

function isThreadTerminal(threadId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT is_terminal FROM a2a_threads WHERE thread_id = ?').get(threadId) as { is_terminal: number } | undefined;
  return row?.is_terminal === 1;
}

function getThreadHopCount(threadId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT hop_count FROM a2a_threads WHERE thread_id = ?').get(threadId) as { hop_count: number } | undefined;
  return row?.hop_count ?? 0;
}

function recordDelivery(threadId: string, intent: A2AIntent, senderId: string): number {
  const db = getDb();
  const terminal = isTerminalIntent(intent) ? 1 : 0;
  db.prepare(`
    UPDATE a2a_threads
    SET hop_count = hop_count + 1,
        last_intent = ?,
        last_sender = ?,
        is_terminal = CASE WHEN ? = 1 THEN 1 ELSE is_terminal END,
        updated_at = datetime('now')
    WHERE thread_id = ?
  `).run(intent, senderId, terminal, threadId);

  return getThreadHopCount(threadId);
}

// ── Semantic Deduplication ──

async function checkSemanticDedup(payload: string, threadId: string): Promise<boolean> {
  try {
    const { generateEmbedding } = await import('../memory/embeddings.js');

    // Get last N messages on this thread
    const db = getDb();
    const recentMessages = db.prepare(`
      SELECT content FROM messages
      WHERE a2a_thread_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(threadId, DEDUP_LOOKBACK) as Array<{ content: string }>;

    if (recentMessages.length === 0) return false;

    // Generate embedding for the new payload
    const newEmbedding = await generateEmbedding(payload);

    // Compare against each recent message
    for (const msg of recentMessages) {
      // Extract payload from the tagged message format
      const msgPayload = extractPayloadFromA2AMessage(msg.content);
      if (!msgPayload || msgPayload.length < 10) continue;

      const existingEmbedding = await generateEmbedding(msgPayload);
      const similarity = cosineSimilarity(newEmbedding, existingEmbedding);

      if (similarity > DEDUP_SIMILARITY_THRESHOLD) {
        logger.info('Semantic dedup: message is too similar to recent thread message', {
          threadId,
          similarity: similarity.toFixed(3),
          threshold: DEDUP_SIMILARITY_THRESHOLD,
        });
        return true; // Duplicate detected
      }
    }

    return false;
  } catch (err) {
    // Embedding service unavailable — skip dedup, deliver the message.
    // Dedup is a nice-to-have, not a gate.
    logger.debug('Semantic dedup skipped (embedding unavailable)', {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function extractPayloadFromA2AMessage(content: string): string | null {
  // New format: [A2A:INTENT thread:xxx from:Name] payload
  const a2aMatch = content.match(/^\[A2A:\w+ thread:\S+ from:[^\]]+\]\s*([\s\S]*?)(\n\n\[Thread|$)/);
  if (a2aMatch) return a2aMatch[1].trim();

  // Legacy format: [SOURCE: AGENT MESSAGE FROM ...] payload
  const legacyMatch = content.match(/^\[SOURCE: (?:AGENT MESSAGE|PM AGENT POKE|GROUP BROADCAST) FROM [^\]]+\]\s*([\s\S]*?)(\n\n\[(?:To reply|Reply via)|$)/);
  if (legacyMatch) return legacyMatch[1].trim();

  return content.trim();
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ── Logging ──

function logDrop(envelope: A2AEnvelope, reason: A2ADropReason): void {
  logger.info('A2A message dropped', {
    threadId: envelope.threadId,
    from: envelope.fromAgent,
    to: envelope.toAgent,
    intent: envelope.intent,
    reason,
    payloadPreview: envelope.payload.slice(0, 200),
  });
}

// ── Core Delivery Function ──

export interface A2ADeliveryResult {
  delivered: boolean;
  reason?: A2ADropReason;
  threadId: string;
  messageId?: string;
}

/**
 * Central delivery point for ALL inter-agent messages. Enforces the full
 * A2A protocol: envelope validation, terminal-thread gating, semantic
 * dedup, hop counting, and requires_response routing.
 *
 * Returns a result indicating whether the message was delivered or dropped.
 */
export async function deliverA2AMessage(envelope: A2AEnvelope): Promise<A2ADeliveryResult> {
  const db = getDb();

  // ── 1. Validate envelope ──
  if (!envelope.intent || !envelope.payload || !envelope.toAgent || !envelope.fromAgent) {
    logDrop(envelope, 'MALFORMED_ENVELOPE');
    return { delivered: false, reason: 'MALFORMED_ENVELOPE', threadId: envelope.threadId };
  }

  // ── 2. Resolve target agent ──
  let target = db.prepare('SELECT id, name, status FROM agents WHERE id = ?').get(envelope.toAgent) as
    | { id: string; name: string; status: string } | undefined;
  if (!target) {
    target = db.prepare("SELECT id, name, status FROM agents WHERE name = ? AND status != 'terminated' ORDER BY created_at DESC LIMIT 1")
      .get(envelope.toAgent) as { id: string; name: string; status: string } | undefined;
  }
  if (!target) {
    logDrop(envelope, 'AGENT_NOT_FOUND');
    return { delivered: false, reason: 'AGENT_NOT_FOUND', threadId: envelope.threadId };
  }
  if (target.status === 'terminated') {
    logDrop(envelope, 'AGENT_NOT_FOUND');
    return { delivered: false, reason: 'AGENT_NOT_FOUND', threadId: envelope.threadId };
  }

  // ── 3. Enforce terminal intent rules ──
  let requiresResponse = envelope.requiresResponse;
  if (isTerminalIntent(envelope.intent)) {
    requiresResponse = false; // Force — terminal intents never require a response
  }

  // ── 4. Thread state checks ──
  const threadId = envelope.threadId || uuidv4();
  ensureThread(threadId, envelope.fromAgent);

  // Check if thread is terminated and this intent can't reopen it
  if (isThreadTerminal(threadId) && !isReopeningIntent(envelope.intent)) {
    logDrop(envelope, 'TERMINAL_THREAD_CLOSED');
    return { delivered: false, reason: 'TERMINAL_THREAD_CLOSED', threadId };
  }

  // If a reopening intent arrives on a terminal thread, reset the terminal flag
  if (isThreadTerminal(threadId) && isReopeningIntent(envelope.intent)) {
    db.prepare('UPDATE a2a_threads SET is_terminal = 0, updated_at = datetime(\'now\') WHERE thread_id = ?').run(threadId);
  }

  // ── 5. Hop counter ──
  const currentHops = getThreadHopCount(threadId);
  if (currentHops >= MAX_HOPS_PER_THREAD) {
    logDrop(envelope, 'HOP_LIMIT_EXCEEDED');
    return { delivered: false, reason: 'HOP_LIMIT_EXCEEDED', threadId };
  }

  // ── 6. Semantic dedup ──
  const isDuplicate = await checkSemanticDedup(envelope.payload, threadId);
  if (isDuplicate) {
    logDrop(envelope, 'SEMANTIC_DUPLICATE');
    return { delivered: false, reason: 'SEMANTIC_DUPLICATE', threadId };
  }

  // ── 7. Record delivery in thread state ──
  recordDelivery(threadId, envelope.intent, envelope.fromAgent);

  // ── 8. Resolve sender name ──
  const senderRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(envelope.fromAgent) as { name: string } | undefined;
  const senderName = senderRow?.name ?? envelope.fromAgent;

  // ── 9. Build the message content with structured tag ──
  const threadInfo = requiresResponse
    ? `\n\n[Thread ${threadId.slice(0, 8)} | Reply expected — use send_to_agent with thread_id="${threadId}" and an appropriate intent]`
    : `\n\n[Thread ${threadId.slice(0, 8)} | No reply expected — this is read-only context]`;

  const contextMessage = `[A2A:${envelope.intent} thread:${threadId.slice(0, 8)} from:${senderName}] ${envelope.payload}${threadInfo}`;

  // ── 10. Persist to messages table ──
  const msgId = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, created_at)
    VALUES (?, ?, 'user', ?, ?, ?, ?, ?, datetime('now'))
  `).run(msgId, target.id, contextMessage, envelope.fromAgent, threadId, envelope.intent, requiresResponse ? 1 : 0);

  // ── 11. Handle attachments (if any) ──
  // Attachment pass-through follows the same pattern as the old send_to_agent
  if (envelope.attachPaths && envelope.attachPaths.length > 0) {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');

      const recipientDir = path.join(os.homedir(), '.dojo', 'uploads', target.id);
      if (!fs.existsSync(recipientDir)) {
        fs.mkdirSync(recipientDir, { recursive: true });
      }

      interface UploadedFile {
        fileId: string;
        filename: string;
        mimeType: string;
        size: number;
        path: string;
        category: string;
      }
      const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
      const attachments: UploadedFile[] = [];

      for (const srcPath of envelope.attachPaths) {
        if (!fs.existsSync(srcPath)) continue;
        const stat = fs.statSync(srcPath);
        if (stat.size > 20 * 1024 * 1024) continue;

        const ext = path.extname(srcPath).toLowerCase();
        const safeName = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
        const storedName = `a2a_${Date.now()}_${safeName}`;
        const destPath = path.join(recipientDir, storedName);
        fs.copyFileSync(srcPath, destPath);

        attachments.push({
          fileId: uuidv4(),
          filename: path.basename(srcPath),
          mimeType: IMAGE_EXTS.includes(ext) ? `image/${ext.slice(1)}` : 'application/octet-stream',
          size: stat.size,
          path: destPath,
          category: IMAGE_EXTS.includes(ext) ? 'image' : 'unknown',
        });
      }

      if (attachments.length > 0) {
        db.prepare('UPDATE messages SET attachments = ? WHERE id = ?').run(JSON.stringify(attachments), msgId);
      }
    } catch { /* attachment pass-through is best-effort */ }
  }

  // ── 12. Broadcast to dashboard ──
  broadcast({
    type: 'chat:message',
    agentId: target.id,
    message: {
      id: msgId,
      agentId: target.id,
      role: 'user' as const,
      content: contextMessage,
      tokenCount: null,
      modelId: null,
      cost: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
    },
  });

  // ── 13. Route based on requires_response ──
  if (requiresResponse) {
    // Don't try to wake agents in error/paused status — it will likely
    // fail or compound the error. Exception: system-level senders
    // (injury alerts) and the healer agent can poke injured agents.
    const targetIsDown = target.status === 'error' || target.status === 'paused';
    let senderCanWakeDown = envelope.fromAgent === 'system';
    if (!senderCanWakeDown && targetIsDown) {
      try {
        const { isHealerAgent } = await import('../config/platform.js');
        senderCanWakeDown = isHealerAgent(envelope.fromAgent);
      } catch { /* */ }
    }

    if (targetIsDown && !senderCanWakeDown) {
      logger.info('A2A delivery: skipping handleMessage for injured/paused agent', {
        targetId: target.id,
        targetStatus: target.status,
        from: envelope.fromAgent,
      });
      // Message is persisted and broadcast (steps 10-12 above), but the
      // agent is not woken. The message becomes read-only context, same as
      // requires_response=false. The healer will handle recovery separately.
    } else {
      const runtime = getAgentRuntime();
      runtime.handleMessage(target.id, contextMessage).catch(err => {
        logger.error('A2A delivery: failed to wake receiver', {
          targetId: target!.id,
          threadId,
          error: err instanceof Error ? err.message : String(err),
        }, envelope.fromAgent);
      });
    }
  }
  // If requires_response is false: message is persisted and broadcast
  // but the receiver is NOT woken. It becomes read-only context on
  // their next natural turn. No tokens spent on the receiver's side.

  logger.info('A2A message delivered', {
    messageId: msgId,
    threadId,
    from: envelope.fromAgent,
    fromName: senderName,
    to: target.id,
    toName: target.name,
    intent: envelope.intent,
    requiresResponse,
    hopCount: currentHops + 1,
    payloadLength: envelope.payload.length,
  }, envelope.fromAgent);

  return { delivered: true, threadId, messageId: msgId };
}

/**
 * Helper to build a thread ID from a contextual seed.
 * Consistent thread IDs for the same context (e.g., task pokes)
 * keep related messages grouped together.
 */
export function makeThreadId(seed: string): string {
  // Simple deterministic hash — same seed always produces the same thread ID
  // This lets us group e.g. all pokes for a task into one thread
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return `thread-${Math.abs(hash).toString(36)}-${seed.slice(0, 8)}`;
}
