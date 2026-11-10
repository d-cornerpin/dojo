// The artifact folder is made at the top of every turn, the one door every agent action passes.
import { artifactDirFor } from './manifest.js';
import { createLogger } from '../logger.js';

const logger = createLogger('artifact-dir');

/** `mkdir -p`, owner-only. Never throws: a folder that cannot be made is a warning, not a failed turn. */
export async function ensureArtifactDir(agentId: string): Promise<void> {
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(artifactDirFor(agentId), { recursive: true, mode: 0o700 });
  } catch (err) {
    logger.warn('could not make the agent\'s artifact folder', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
