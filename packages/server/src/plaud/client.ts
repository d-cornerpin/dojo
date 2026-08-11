// ════════════════════════════════════════
// Plaud CLI Client
// All Plaud agent tools shell out through here. The Plaud CLI (npm package
// @plaud-ai/cli) is the source of truth for auth, transport, and refresh.
// We never store tokens ourselves - the CLI owns ~/.plaud/tokens.json.
//
// Why CLI and not MCP: Plaud's MCP server requires a long-lived stdio
// subprocess + JSON-RPC client + dynamic schema translation. The CLI fits
// our existing "tool function → shell call → parse JSON" pattern with no
// new subsystems. See the integration audit (2026-05-25) for the full
// comparison.
// ════════════════════════════════════════

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('plaud-client');

// `npx -y @plaud-ai/cli@latest <cmd>` - no global install required.
// npx caches the package after first invocation, so subsequent calls are
// fast. The `-y` flag skips the "install package?" prompt.
const PLAUD_NPM_PACKAGE = '@plaud-ai/cli@latest';

export interface PlaudCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Exit code 2 from the CLI means re-auth required. */
  needsReauth: boolean;
  error?: string;
}

/**
 * Run a Plaud CLI command. Captures stdout/stderr, surfaces exit-code-2
 * (re-auth required) as a distinct flag so callers can route the user
 * back to the Settings → Integrations → Plaud reconnect button.
 *
 * Default timeout is 30s - generous for individual queries but bounded
 * so a hung CLI doesn't pin the request thread forever.
 */
export async function runPlaudCommand(
  args: string[],
  options: { timeoutMs?: number; agentId?: string | null } = {},
): Promise<PlaudCommandResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fullArgs = ['-y', PLAUD_NPM_PACKAGE, ...args];

  try {
    const { stdout, stderr } = await execFileAsync('npx', fullArgs, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024, // 16MB - transcripts can be long
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` },
    });
    return { ok: true, stdout, stderr, needsReauth: false };
  } catch (err) {
    const e = err as { code?: number; signal?: string; stdout?: string; stderr?: string; message?: string };
    const exitCode = typeof e.code === 'number' ? e.code : null;
    const stdout = e.stdout ?? '';
    const stderr = e.stderr ?? '';
    const errMsg = e.message ?? String(err);

    const needsReauth = exitCode === 2 || /not.{0,5}logged in|reauth|sign in again/i.test(stderr + stdout);

    if (needsReauth) {
      logger.warn('Plaud command needs reauth', { args: args[0], exitCode });
      // ── UX-REPAIR T38: THE ONE PLACE THE EXPIRY IS NOTICED ──
      // `needsReauth` is computed here and nowhere else, so this is where the
      // transition gets recorded and the user gets told — once per episode, by
      // `notePlaudReauthRequired`. Before this, every caller turned the flag
      // into a sentence for the model and dropped it on the floor.
      //
      // `logout` is EXCLUDED: `plaudLogout` runs it, and a CLI that answers
      // "not logged in" to an intentional logout is agreeing with the user, not
      // reporting an expiry.
      //
      // Dynamic import, deliberately: `plaud/auth.ts` imports this module
      // statically, so a static import back would be a cycle. Same shape the
      // runtime already uses for `a2a-transport`.
      if (args[0] !== 'logout') {
        try {
          const { notePlaudReauthRequired } = await import('./auth.js');
          notePlaudReauthRequired(options.agentId ?? null);
        } catch (noteErr) {
          logger.warn('Plaud reauth notice failed (non-fatal)', {
            error: noteErr instanceof Error ? noteErr.message : String(noteErr),
          });
        }
      }
    } else {
      logger.error('Plaud command failed', {
        args: args[0], exitCode, signal: e.signal,
        stderr: stderr.slice(0, 500),
      });
    }

    return {
      ok: false,
      stdout,
      stderr,
      needsReauth,
      error: needsReauth
        ? 'Plaud is no longer connected (token expired or revoked). Reconnect from Settings → Integrations → Plaud.'
        : errMsg,
    };
  }
}

/**
 * Run a Plaud command and try to parse the stdout as JSON. The CLI's
 * structured commands (`files`, `file`, `me`, etc.) output JSON; the
 * narrative ones (`transcript`, `summary`) output Markdown or plain text
 * - those callers should use runPlaudCommand directly.
 *
 * Returns the parsed JSON OR a normalized error string suitable for
 * direct return to the agent as a tool result.
 */
export async function runPlaudJson<T = unknown>(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string; needsReauth: boolean }> {
  const result = await runPlaudCommand(args, options);
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Plaud command failed.', needsReauth: result.needsReauth };
  }
  try {
    const data = JSON.parse(result.stdout) as T;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: `Plaud returned non-JSON output for \`${args[0]}\`: ${result.stdout.slice(0, 300)}`,
      needsReauth: false,
    };
  }
}
