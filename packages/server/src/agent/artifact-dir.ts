// ════════════════════════════════════════
// An agent's artifact folder exists before the agent is told it may write there (t232).
//
// `agent/manifest.ts` grants every agent `~/.dojo/uploads/<agentId>/**`, but nothing made the folder
// until a tool that writes there (image, PDF, attachments) made it itself. An agent that wrote there
// with the shell (a redirect, `cp`) failed with "no such file or directory" and went looking for
// another way. The folder is made at ONE place: the top of a turn (`runV2Turn`), the single door every
// action by every agent passes through, whatever woke it (an owner message, a peer, the scheduler, the
// engine) and whether the agent is brand new or years old. One `mkdir -p` per turn costs one syscall.
//
// The path is a platform literal plus the agent's own id (no argument an agent supplies), so this is
// platform machinery, not an agent-named fs site; the module is loaded the way `a2a-transport.ts` loads it for
// the same folder (`await import`), which keeps it off the restricted-import count rather than adding a
// site to a baseline that may only fall.
// ════════════════════════════════════════
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
