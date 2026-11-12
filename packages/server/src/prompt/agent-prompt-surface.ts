// The one read/write door for an agent's stored identity: the card, update_agent and the profile tool
// all use the store the runtime reads (resolved in assembler.ts), never their own SELECT.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { soulFileForAgent, assertSoulReadable, readSoulFile, writeSoulFile, readStoredCharter } from './assembler.js';

const logger = createLogger('agent-prompt-surface');

export function readAgentPromptSurface(agentId: string): string {
  const soul = soulFileForAgent(agentId);
  if (soul) {
    // An unreadable soul file throws (the card shows Retry) rather than falling back to the default.
    assertSoulReadable(soul);
    return readSoulFile(soul);
  }
  return readStoredCharter(agentId);
}

/** Write the identity to the store the runtime reads: the soul file, else the agents.charter column. */
export function writeAgentPromptSurface(agentId: string, content: string): void {
  const soul = soulFileForAgent(agentId);
  if (soul) {
    writeSoulFile(soul, content);
    logger.info('agent identity updated in its prompt file', { agentId, file: soul.file, chars: content.length });
    return;
  }
  const db = getDb();
  db.prepare('UPDATE agents SET charter = ? WHERE id = ?').run(content, agentId);
  logger.info('agent identity updated in agents.charter', { agentId, chars: content.length });
}
