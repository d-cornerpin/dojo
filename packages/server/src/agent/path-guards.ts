// The share gate: share_file, share_publicly and canvas_render hand file bytes somewhere
// the agent chose; the one file check has already asked the read permission.

import { resolveHomePath } from './path-resolve.js';
import { shareDeny } from './brokers/fs.js';
import { resolvePathArg } from './brokers/resolve.js';

// Re-exported published surface: consumers import these names from HERE.
export {
  probeFsCaseInsensitive, setFsCaseInsensitive, isFsCaseInsensitive, foldPath,
  type ProbeFs,
} from './fs-case.js';
export { isSensitivePath, SENSITIVE_BASENAMES } from './brokers/deny.js';

export const resolvePath = resolveHomePath;

// blockedMessage === null: the path did not resolve; the caller renders its own message.
export type SharePathVerdict =
  | { allowed: true; absPath: string }
  | { allowed: false; absPath: string; reason: string; blockedMessage: string | null };

// The share surface's own question, asked after the one file check: a file the agent may
// read may still not be published or shown. Agents parse these strings: keep [BLOCKED].
export async function sharePathGuard(
  agentId: string,
  toolName: string,
  rawPath: string,
): Promise<SharePathVerdict> {
  const absPath = resolveHomePath(rawPath);
  const resolved = resolvePathArg(absPath);
  if (!resolved.ok) return { allowed: false, absPath, reason: resolved.reason, blockedMessage: null };
  const sensitive = shareDeny(resolved.value, toolName);
  if (sensitive && !sensitive.allowed) {
    return { allowed: false, absPath, reason: sensitive.reason, blockedMessage: sensitive.blockedMessage };
  }
  return { allowed: true, absPath };
}
