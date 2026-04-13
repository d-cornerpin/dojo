// ════════════════════════════════════════
// Model Switch Sanitizer
//
// When an agent's model changes, tool_use/tool_result messages in their
// history may contain IDs from the old model that the new model can't
// reconcile. Some providers (MiniMax, etc.) reject messages with
// unrecognized tool IDs entirely.
//
// This function collapses tool call chains into plain-text summaries
// so the agent keeps their context in a format any model can handle.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('model-switch');

/**
 * Sanitize an agent's message history after a model change.
 * Collapses tool_use (assistant) and tool_result (tool) message pairs
 * into plain-text assistant messages that preserve the information
 * without provider-specific tool call IDs.
 */
export function sanitizeMessagesOnModelChange(agentId: string): { collapsed: number } {
  const db = getDb();
  let collapsed = 0;

  // Find all assistant messages that contain tool_use blocks
  const assistantRows = db.prepare(`
    SELECT id, content, created_at FROM messages
    WHERE agent_id = ? AND role = 'assistant' AND content LIKE '%tool_use%'
    ORDER BY created_at ASC, rowid ASC
  `).all(agentId) as Array<{ id: string; content: string; created_at: string }>;

  for (const row of assistantRows) {
    try {
      const blocks = JSON.parse(row.content);
      if (!Array.isArray(blocks)) continue;

      const hasToolUse = blocks.some((b: Record<string, unknown>) => b.type === 'tool_use');
      if (!hasToolUse) continue;

      // Extract text and tool call info
      const textParts: string[] = [];
      const toolCallSummaries: string[] = [];

      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text as string);
        } else if (block.type === 'tool_use') {
          const name = block.name as string;
          const input = block.input as Record<string, unknown> | undefined;
          const argSummary = input ? Object.keys(input).join(', ') : '';
          toolCallSummaries.push(`[Called ${name}(${argSummary})]`);
        }
      }

      // Find the matching tool_result message (should be the next message)
      const toolResultRow = db.prepare(`
        SELECT id, content FROM messages
        WHERE agent_id = ? AND role = 'tool' AND created_at >= ?
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
      `).get(agentId, row.created_at) as { id: string; content: string } | undefined;

      let resultSummaries: string[] = [];
      if (toolResultRow) {
        try {
          const resultBlocks = JSON.parse(toolResultRow.content);
          if (Array.isArray(resultBlocks)) {
            for (const rb of resultBlocks) {
              if (rb.type === 'tool_result') {
                const resultContent = typeof rb.content === 'string' ? rb.content : JSON.stringify(rb.content);
                const truncated = resultContent.length > 200
                  ? resultContent.slice(0, 200) + '...'
                  : resultContent;
                const errorLabel = rb.is_error ? ' (ERROR)' : '';
                resultSummaries.push(`[Result${errorLabel}: ${truncated}]`);
              }
            }
          }
        } catch { /* not JSON */ }
      }

      // Build the collapsed plain-text version
      const collapsedParts = [
        ...textParts,
        ...toolCallSummaries,
        ...resultSummaries,
      ];
      const collapsedText = collapsedParts.join('\n');

      // Update the assistant message to plain text
      db.prepare(`
        UPDATE messages SET content = ?, updated_at = datetime('now') WHERE id = ?
      `).run(collapsedText, row.id);

      // Delete the tool_result message (its info is now in the collapsed text)
      if (toolResultRow) {
        db.prepare('DELETE FROM messages WHERE id = ?').run(toolResultRow.id);
      }

      collapsed++;
    } catch {
      // Skip messages that aren't valid JSON
      continue;
    }
  }

  if (collapsed > 0) {
    logger.info('Collapsed tool call messages after model change', {
      agentId, collapsed,
    }, agentId);
  }

  return { collapsed };
}
