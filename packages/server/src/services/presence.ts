// ════════════════════════════════════════
// User Presence — In the Dojo / Away
// Routes agent-to-user messages through iMessage when away
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { sendIMessage, getDefaultSender, getIMBridgeStatus } from './imessage-bridge.js';
import { isPrimaryAgent, isPMAgent, getPrimaryAgentName, getPMAgentName } from '../config/platform.js';

const logger = createLogger('presence');

export type PresenceStatus = 'in_dojo' | 'away';

export function getPresence(): PresenceStatus {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'user_presence'").get() as { value: string } | undefined;
    return (row?.value === 'away') ? 'away' : 'in_dojo';
  } catch {
    return 'in_dojo';
  }
}

export function setPresence(status: PresenceStatus): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES ('user_presence', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(status, status);
  logger.info('User presence changed', { status });
}

export function isImessageConfigured(): boolean {
  const status = getIMBridgeStatus();
  // "Configured" means senders are set up — the bridge doesn't need to be actively running
  return (status.enabled || status.running) && !!getDefaultSender();
}

/**
 * Distill an agent's response into a brief, friendly text message.
 * Strips markdown, tool calls, verbose content. Keeps only conversational text.
 */
function distillForText(content: string, agentName: string): string {
  let text = content;

  // Strip === File: === blocks
  text = text.replace(/\n=== File: .+? ===\n[\s\S]*?\n=== End File ===/g, '');

  // Strip markdown headers
  text = text.replace(/^#{1,6}\s+/gm, '');

  // Strip markdown bold/italic
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/_(.+?)_/g, '$1');

  // Strip code blocks
  text = text.replace(/```[\s\S]*?```/g, '[code block]');
  text = text.replace(/`([^`]+)`/g, '$1');

  // Strip markdown links
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Strip bullet points
  text = text.replace(/^[\s]*[-*•]\s/gm, '');

  // Collapse whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // Truncate to reasonable text message length
  if (text.length > 500) {
    const truncated = text.slice(0, 480);
    const lastSentence = truncated.lastIndexOf('.');
    text = (lastSentence > 200 ? truncated.slice(0, lastSentence + 1) : truncated) + '...';
  }

  // Prefix with agent name
  return `${agentName}: ${text}`;
}

/**
 * Called after an agent produces a final text response (no tool calls).
 * If the user is away and this is a primary/PM agent, forward via iMessage.
 */
export function maybeForwardToImessage(agentId: string, content: string): void {
  if (getPresence() !== 'away') return;
  if (!isImessageConfigured()) return;

  // Only forward messages from the primary agent and PM agent
  if (!isPrimaryAgent(agentId) && !isPMAgent(agentId)) return;

  // Don't forward empty or very short responses
  if (!content || content.trim().length < 10) return;

  // Don't forward system/internal messages
  if (content.startsWith('[System]') || content.startsWith('[Task Update]')) return;

  const agentName = isPrimaryAgent(agentId) ? getPrimaryAgentName() : getPMAgentName();
  const recipient = getDefaultSender();
  if (!recipient) return;

  const text = distillForText(content, agentName);

  try {
    sendIMessage(recipient, text);
    logger.info('Forwarded agent response via iMessage (user away)', {
      agentId,
      agentName,
      originalLength: content.length,
      textLength: text.length,
    });
  } catch (err) {
    logger.error('Failed to forward via iMessage', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
