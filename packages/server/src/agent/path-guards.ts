// ════════════════════════════════════════
// Path guards — the SHARE gate (PHASE-0 T10, rebuilt on the brokers PHASE-5 T2)
// ════════════════════════════════════════
//
// THE SHARE GATE. `share_file` / `share_publicly` / the pdf_* tools all read an
// arbitrary path and hand its bytes somewhere the agent chose — a public URL,
// the model's context. `file_read` and `file_patch` have refused sensitive paths
// for a long time; these three simply never asked. They ask here, through the
// same merged deny list and the same permission the read tools use.
//
// ── WHAT LEFT THIS FILE AT PHASE-5 T2, AND WHERE IT WENT ──
// The case-folding probe → `agent/fs-case.ts` (a leaf, so the merged deny list
// can fold without closing a cycle). `isSensitivePath` + `SENSITIVE_BASENAMES`
// → `agent/brokers/deny.ts`, where they became rows of the ONE deny list beside
// the three global lists that used to live in `permissions.ts`. `resolvePath`
// → `agent/path-resolve.ts`. Every one of those names is re-exported from here,
// so `tools.ts`, `public-share.ts`, `index.ts` and the tests did not move.
//
// The dynamic `await import('./permissions.js')` at the old `:208` is GONE with
// the cycle it was breaking: `permissions.ts` no longer owns the deny lists, so
// nothing here has to be loaded late to avoid it.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { resolveHomePath } from './path-resolve.js';
import { getAgentPermissions } from './manifest.js';
import { grantForManifest } from './brokers/grants.js';
import { authorizeFs, shareDeny } from './brokers/fs.js';
import { resolvePathArg } from './brokers/resolve.js';

const logger = createLogger('path-guards');

// ── Re-exports: this module's published surface, unchanged ──
export {
  probeFsCaseInsensitive, setFsCaseInsensitive, isFsCaseInsensitive, foldPath,
  type ProbeFs,
} from './fs-case.js';
export { isSensitivePath, SENSITIVE_BASENAMES } from './brokers/deny.js';

/** Expand `~` / `~/…` to the home directory. Everything else passes through
 *  unchanged (callers check `path.isAbsolute` themselves). */
export const resolvePath = resolveHomePath;

// ── The share / read gate ──

/**
 * The verdict shape the share and pdf call sites consume.
 *
 * `blockedMessage === null` means the refusal came from the PERMISSION layer,
 * not the sensitive-file list: the caller renders it with its own
 * `permissionDeniedMessage()` so the agent-facing guidance is byte-identical to
 * every other permission block it has ever seen (agents parse these strings —
 * `agent/v2/loop.ts` keys retry behaviour off the `[BLOCKED]` prefix).
 */
export type SharePathVerdict =
  | { allowed: true; absPath: string }
  | { allowed: false; absPath: string; reason: string; blockedMessage: string | null };

/**
 * resolve → the sensitive tier of the merged deny list → the fs broker's read
 * authorization. Every path a tool is about to READ OUT — publish to a URL,
 * extract into the model's context — goes through here first.
 *
 * Still `async` so the six existing call sites do not move; the brokers answer
 * this shape synchronously.
 */
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

/**
 * Every path a pdf_* call would READ: `path` (most tools), `input_paths`
 * (pdf_merge), and the `path` on pdf_create's image content blocks. Output
 * filenames are excluded — those are resolved into the agent's own upload
 * directory by pdf-tools.ts and never name a caller-chosen location.
 */
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
