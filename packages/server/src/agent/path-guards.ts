// The share gate: share_file / share_publicly / the pdf_* tools hand file bytes somewhere
// the agent chose, so they must pass the same deny list and permission the read tools use.

import { createLogger } from '../logger.js';
import { resolveHomePath } from './path-resolve.js';
import { getAgentPermissions } from './manifest.js';
import { grantForManifest } from './brokers/grants.js';
import { authorizeFs, shareDeny } from './brokers/fs.js';
import { resolvePathArg } from './brokers/resolve.js';

const logger = createLogger('path-guards');

// Re-exported published surface: consumers import these names from HERE.
export {
  probeFsCaseInsensitive, setFsCaseInsensitive, isFsCaseInsensitive, foldPath,
  type ProbeFs,
} from './fs-case.js';
export { isSensitivePath, SENSITIVE_BASENAMES } from './brokers/deny.js';

export const resolvePath = resolveHomePath;

// blockedMessage === null: the PERMISSION layer refused; the caller renders its own
// message. Agents parse these strings, so keep the [BLOCKED] prefix intact.
export type SharePathVerdict =
  | { allowed: true; absPath: string }
  | { allowed: false; absPath: string; reason: string; blockedMessage: string | null };

// resolve, then the sensitive deny tier, then the fs broker's read grant.
// Every path a tool reads out (URL publish, model context) passes here first.
// async stays: existing call sites depend on it, brokers answer sync anyway.
export async function sharePathGuard(
  agentId: string,
  toolName: string,
  rawPath: string,
): Promise<SharePathVerdict> {
  const absPath = resolveHomePath(rawPath);

  const resolved = resolvePathArg(absPath);
  if (!resolved.ok) {
    return { allowed: false, absPath, reason: resolved.reason, blockedMessage: null };
  }

  const sensitive = shareDeny(resolved.value, toolName);
  if (sensitive && !sensitive.allowed) {
    return {
      allowed: false,
      absPath,
      reason: sensitive.reason,
      blockedMessage: sensitive.blockedMessage,
    };
  }

  const grant = grantForManifest(agentId, getAgentPermissions(agentId));
  const verdict = authorizeFs(grant, 'fs_read', resolved.value);
  if (!verdict.allowed) {
    logger.info('share path refused by the fs broker', { toolName, rule: verdict.rule }, agentId);
    return {
      allowed: false,
      absPath,
      reason: verdict.reason ?? `file_read not allowed for path: ${absPath}`,
      blockedMessage: null,
    };
  }

  return { allowed: true, absPath };
}

// Every path a pdf_* tool READS: path, input_paths, image block paths. Output
// names excluded: they land in the agent's own upload dir, never a caller dir.
export function pdfInputPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) out.push(value);
  };
  push(args.path);
  if (Array.isArray(args.input_paths)) for (const p of args.input_paths) push(p);
  if (Array.isArray(args.content)) {
    for (const block of args.content) {
      if (block && typeof block === 'object') push((block as { path?: unknown }).path);
    }
  }
  return out;
}
