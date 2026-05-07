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

// Terminal intents CLOSE the thread (prevent acknowledgement replies).
// But closing the thread and waking the receiver are INDEPENDENT concepts.
const TERMINAL_INTENTS = new Set<A2AIntent>(['DELIVERABLE', 'FYI', 'COMPLETE', 'FAIL', 'ANSWER']);
const REOPENING_INTENTS = new Set<A2AIntent>(['QUESTION', 'BLOCK', 'ASSIGN']);

// "No-wake" intents: terminal AND the receiver doesn't need to see it now.
// ANSWER and DELIVERABLE are terminal but DO wake — the receiver is waiting
// for the content to continue their work. The thread closure prevents
// acknowledgement loops separately.
const NO_WAKE_INTENTS = new Set<A2AIntent>(['FYI', 'STATUS', 'COMPLETE', 'FAIL']);

const MAX_HOPS_PER_THREAD = 8;
const DEDUP_SIMILARITY_THRESHOLD = 0.85;
const DEDUP_LOOKBACK = 3;

function isTerminalIntent(intent: A2AIntent): boolean { return TERMINAL_INTENTS.has(intent); }
function isNoWakeIntent(intent: A2AIntent): boolean { return NO_WAKE_INTENTS.has(intent); }
function isReopeningIntent(intent: A2AIntent): boolean { return REOPENING_INTENTS.has(intent); }

// Re-export for callers that need these (tools.ts)
export { isTerminalIntent, isNoWakeIntent, isReopeningIntent, type A2AIntent };

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

async function checkSemanticDedup(payload: string, threadId: string, fromAgent: string): Promise<boolean> {
  try {
    const { generateEmbedding } = await import('../memory/embeddings.js');

    // Get last N messages on this thread FROM THE SAME SENDER. Pre-2026-04-30
    // dedup compared against messages from any sender on the thread, which
    // meant an agent's reply could be flagged as duplicate against the
    // receiver's earlier question (because the reply naturally repeats the
    // question's terms). The honest signal is "this sender is repeating
    // themselves" — that's what we now check.
    const db = getDb();
    const recentMessages = db.prepare(`
      SELECT content FROM messages
      WHERE a2a_thread_id = ? AND source_agent_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(threadId, fromAgent, DEDUP_LOOKBACK) as Array<{ content: string }>;

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
        logger.info('Semantic dedup: sender is repeating themselves on thread', {
          threadId,
          fromAgent,
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
  /**
   * For ASSIGN-intent deliveries, the engine auto-creates a tracker task
   * for the receiver. The ID is returned here so the sender's tool result
   * can surface it ("Task tracker_xyz created and assigned to Maddy").
   * Undefined for non-ASSIGN intents and for ASSIGN messages that reused
   * an existing thread's task.
   */
  autoCreatedTaskId?: string;
  /**
   * True when the auto-task was just created by THIS delivery; false when
   * we reused a task from an earlier ASSIGN on the same thread.
   */
  autoTaskIsNew?: boolean;
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

  // ── 3. Enforce intent rules ──
  // Two independent concepts:
  //   - Terminal: closes the thread (prevents acknowledgement replies)
  //   - No-wake: receiver is NOT woken (message is read-only context)
  //
  // ANSWER and DELIVERABLE are terminal (close thread) but DO wake the
  // receiver — the receiver asked for this content and needs it to
  // continue working. FYI, STATUS, COMPLETE, FAIL are both terminal
  // AND no-wake — nobody is waiting for them.
  let requiresResponse = envelope.requiresResponse;
  if (isNoWakeIntent(envelope.intent)) {
    requiresResponse = false; // Force — these intents never wake the receiver
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
  // Skip for completion intents (ANSWER, DELIVERABLE, COMPLETE, FAIL).
  // Those are work-finished announcements — meaningful checkpoints that
  // need to land regardless of phrasing similarity. Dedup was meant to
  // silence acknowledgement loops ("thanks!" / "you're welcome!"), not
  // completion notices. FYI keeps dedup because it's the prime culprit
  // for back-and-forth ack loops between agents.
  const COMPLETION_INTENTS_SKIP_DEDUP = new Set<A2AIntent>(['ANSWER', 'DELIVERABLE', 'COMPLETE', 'FAIL']);
  if (!COMPLETION_INTENTS_SKIP_DEDUP.has(envelope.intent)) {
    const isDuplicate = await checkSemanticDedup(envelope.payload, threadId, envelope.fromAgent);
    if (isDuplicate) {
      logDrop(envelope, 'SEMANTIC_DUPLICATE');
      return { delivered: false, reason: 'SEMANTIC_DUPLICATE', threadId };
    }
  }

  // ── 7. Record delivery in thread state ──
  recordDelivery(threadId, envelope.intent, envelope.fromAgent);

  // ── 8. Resolve sender name ──
  const senderRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(envelope.fromAgent) as { name: string } | undefined;
  const senderName = senderRow?.name ?? envelope.fromAgent;

  // ── 8.5. Engine-driven auto-task on ASSIGN ──
  // Cross-agent task discipline: when an agent uses intent=ASSIGN, the
  // engine auto-creates a tracker task on their behalf so the assignment
  // is structurally tracked from the moment of the handoff. Both sides
  // see the task ID in their respective views (sender via tool result,
  // receiver via the threadInfo footer below). PM's existing poke loop
  // then picks up stalled ASSIGN tasks for free.
  //
  // Reuses an existing task if one already exists for this thread, so
  // multiple ASSIGN messages on the same thread are clarifications, not
  // duplicate assignments.
  let autoTask: { taskId: string; isNew: boolean } | null = null;
  if (envelope.intent === 'ASSIGN') {
    try {
      const { autoCreateAssignTask } = await import('../tracker/schema.js');
      autoTask = autoCreateAssignTask({
        senderId: envelope.fromAgent,
        receiverId: target.id,
        payload: envelope.payload,
        threadId,
      });
    } catch (err) {
      logger.warn('A2A ASSIGN: auto-task creation failed — delivering message anyway', {
        threadId, error: err instanceof Error ? err.message : String(err),
      }, envelope.fromAgent);
    }
  }

  // ── 9. Build the message content with structured tag ──
  // The footer must accurately reflect the intent's reply rules. Pre-2026-04-30
  // it branched on `requiresResponse`, which collapsed terminal-wake intents
  // (ANSWER/DELIVERABLE — wake but thread is closed) into the same footer as
  // open-thread intents (QUESTION/ASSIGN/BLOCK — wake AND reply). The result:
  // a DELIVERABLE message body said "do not reply" while the footer said
  // "Reply expected — use send_to_agent". Receiving agents read both and
  // got confused. Now there are three honest states, one per intent group.
  const threadShort = threadId.slice(0, 8);
  let threadInfo: string;
  if (envelope.intent === 'QUESTION' || envelope.intent === 'ASSIGN' || envelope.intent === 'BLOCK') {
    // Open-thread reply intents — receiver should reply on the same thread.
    threadInfo = `\n\n[Thread ${threadShort} | Reply on this thread — use send_to_agent with thread_id="${threadId}" and an appropriate intent]`;
    if (envelope.intent === 'ASSIGN' && autoTask) {
      // Receiver-visible tracker line. The DOJO created the task for them,
      // so they don't need to call tracker_create_task — they just need
      // to call tracker_update_status when done so the sender gets the
      // completion notification automatically.
      const taskShort = autoTask.taskId.slice(0, 8);
      threadInfo += autoTask.isNew
        ? `\n[Tracker: task ${taskShort} was auto-created when ${senderName} assigned this work to you. Call tracker_update_status(task_id="${autoTask.taskId}", status="completed", notes="…") when you finish so ${senderName} gets the completion notice.]`
        : `\n[Tracker: continuing work on task ${taskShort} (assigned earlier on this thread by ${senderName}). Update status with tracker_update_status when state changes.]`;
    }
  } else if (envelope.intent === 'ANSWER' || envelope.intent === 'DELIVERABLE') {
    // Terminal but wake — receiver should USE the content (relay to user,
    // act on it) but the thread is closed; replying on it will fail with
    // TERMINAL_THREAD_CLOSED. To continue with the sender, start a NEW
    // thread (omit thread_id) with a reopening intent.
    threadInfo = `\n\n[Thread ${threadShort} | Closed — use the content above (do NOT reply on this thread). To start a new conversation with the sender, omit thread_id and pick QUESTION/ASSIGN/BLOCK.]`;
  } else {
    // No-wake intents (FYI/STATUS/COMPLETE/FAIL) — informational only.
    threadInfo = `\n\n[Thread ${threadShort} | No reply expected — this is read-only context]`;
  }

  const contextMessage = `[A2A:${envelope.intent} thread:${threadShort} from:${senderName}] ${envelope.payload}${threadInfo}`;

  // ── 10. Process attachments BEFORE persist+broadcast ──
  // Pre-2026-04-30: attachments were processed AFTER the message was inserted
  // and the broadcast went out, so the dashboard's chat feed got the message
  // with no attachments. The image only appeared on page refresh (which loads
  // from the persisted DB row). Now we copy and build the attachments list
  // first, then persist and broadcast in one consistent pass.
  interface UploadedFile {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    path: string;
    category: 'unknown' | 'text' | 'image' | 'pdf' | 'office';
  }
  let attachmentsList: UploadedFile[] = [];
  if (envelope.attachPaths && envelope.attachPaths.length > 0) {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');

      const recipientDir = path.join(os.homedir(), '.dojo', 'uploads', target.id);
      if (!fs.existsSync(recipientDir)) {
        fs.mkdirSync(recipientDir, { recursive: true });
      }

      const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

      for (const srcPath of envelope.attachPaths) {
        if (!fs.existsSync(srcPath)) {
          logger.warn('A2A attachment source missing — skipping', { srcPath });
          continue;
        }
        const stat = fs.statSync(srcPath);
        if (stat.size > 20 * 1024 * 1024) {
          logger.warn('A2A attachment too large — skipping', { srcPath, size: stat.size });
          continue;
        }

        const ext = path.extname(srcPath).toLowerCase();

        // If the caller already placed the file in the recipient's uploads
        // dir (e.g., image_create pre-copies to a deterministic path so it
        // can include that path in the message text), skip the re-copy.
        // Otherwise we'd end up with two identical files and the agent
        // would not know which one to use.
        const srcDir = path.dirname(srcPath);
        const alreadyInRecipientDir = path.resolve(srcDir) === path.resolve(recipientDir);

        let destPath: string;
        if (alreadyInRecipientDir) {
          destPath = srcPath;
        } else {
          const safeName = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
          const storedName = `a2a_${Date.now()}_${safeName}`;
          destPath = path.join(recipientDir, storedName);
          fs.copyFileSync(srcPath, destPath);
        }

        attachmentsList.push({
          fileId: uuidv4(),
          filename: path.basename(srcPath),
          mimeType: IMAGE_EXTS.includes(ext) ? `image/${ext.slice(1)}` : 'application/octet-stream',
          size: stat.size,
          path: destPath,
          category: IMAGE_EXTS.includes(ext) ? 'image' as const : 'unknown' as const,
        });
      }
    } catch (err) {
      logger.warn('A2A attachment processing failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      attachmentsList = [];
    }
  }
  const attachmentsJson = attachmentsList.length > 0 ? JSON.stringify(attachmentsList) : null;

  // ── 11. Persist to messages table (with attachments) ──
  const msgId = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, attachments, created_at)
    VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(msgId, target.id, contextMessage, envelope.fromAgent, threadId, envelope.intent, requiresResponse ? 1 : 0, attachmentsJson);

  // ── 12. Broadcast to dashboard (with attachments so the live UI shows the
  // image immediately, not just on page refresh) ──
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
      attachments: attachmentsList.length > 0 ? attachmentsList : undefined,
    },
  });

  // ── 13. Route based on requires_response ──
  if (requiresResponse) {
    // Wake-block for paused-only. Pre-2026-04-29 we also blocked waking
    // agents in `error` status — meant to prevent compound failures, but
    // it caused injured agents to silently ignore PM/peer messages, leaving
    // them stuck until the Healer's grace timer expired. With the in-loop
    // error recovery added in v1.15.76 (capability mismatch / 4xx → system
    // note → adapt), re-waking an injured agent is safe: worst case it
    // re-injures and the Healer takes over, best case it transiently
    // recovers or self-corrects. `paused` (error-loop signal) keeps the
    // block — re-waking there would just compound.
    const targetIsLockedOut = target.status === 'paused';
    let senderCanWakeLockedOut = envelope.fromAgent === 'system';
    if (!senderCanWakeLockedOut && targetIsLockedOut) {
      try {
        const { isHealerAgent } = await import('../config/platform.js');
        senderCanWakeLockedOut = isHealerAgent(envelope.fromAgent);
      } catch { /* */ }
    }

    if (targetIsLockedOut && !senderCanWakeLockedOut) {
      logger.info('A2A delivery: skipping handleMessage for paused agent (error loop)', {
        targetId: target.id,
        targetStatus: target.status,
        from: envelope.fromAgent,
      });
      // Message persisted and broadcast (steps 10-12 above), but the agent
      // is not woken. Healer or system can still wake them.
    } else {
      // Urgent-sender preempt. If this delivery comes from PM (poke), the
      // Healer (injury recovery), or system (engine-level alert) AND the
      // target is currently mid-turn, abort the in-flight model call so
      // the urgent message is processed promptly. Without this preempt,
      // the message gets queued in pendingWakeups and waits up to the
      // 15-minute turn-time-budget for the current turn to end.
      try {
        let isUrgentSender = envelope.fromAgent === 'system';
        if (!isUrgentSender) {
          const { isPMAgent, isHealerAgent } = await import('../config/platform.js');
          isUrgentSender = isPMAgent(envelope.fromAgent) || isHealerAgent(envelope.fromAgent);
        }
        if (isUrgentSender) {
          const { preemptAgentForUrgentMessage } = await import('./runtime.js');
          const preempted = preemptAgentForUrgentMessage(target.id);
          if (preempted) {
            logger.info('A2A delivery: preempted target run for urgent wakeup', {
              targetId: target.id,
              from: envelope.fromAgent,
              intent: envelope.intent,
            });
          }
        }
      } catch { /* preempt is best-effort */ }

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

  return {
    delivered: true,
    threadId,
    messageId: msgId,
    autoCreatedTaskId: autoTask?.taskId,
    autoTaskIsNew: autoTask?.isNew,
  };
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
