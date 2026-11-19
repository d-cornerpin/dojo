// Plaud CLI client: every Plaud agent tool shells out through here. The CLI (@plaud-ai/cli) owns auth,
// transport and refresh; tokens stay in ~/.plaud/tokens.json and are never stored by us.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';
import { openAgentCall } from '../agent/abortable-call.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('plaud-client');

const PLAUD_NPM_PACKAGE = '@plaud-ai/cli@latest';

export interface PlaudCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  needsReauth: boolean;
  error?: string;
}

/** Run a Plaud CLI command; exit code 2 is surfaced as `needsReauth`. The 30s default timeout bounds a hung CLI. */
export async function runPlaudCommand(
  args: string[],
  options: { timeoutMs?: number; agentId?: string | null } = {},
): Promise<PlaudCommandResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fullArgs = ['-y', PLAUD_NPM_PACKAGE, ...args];

  // A call made for an agent is cut by that agent's Stop (execFile kills the CLI on abort).
  const slot = options.agentId ? openAgentCall(options.agentId, 'turn') : null;
  try {
    const { stdout, stderr } = await execFileAsync('npx', fullArgs, {
      timeout: timeoutMs,
      ...(slot ? { signal: slot.signal } : {}),
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
      // `needsReauth` is computed only here, so the expiry is recorded here via `notePlaudReauthRequired`.
      // `logout` is excluded: a "not logged in" answer to an intentional logout is not an expiry.
      // Dynamic import: `plaud/auth.ts` imports this module statically, so a static import back is a cycle.
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
        : `Error: the Plaud command failed: ${errMsg}`,
    };
  } finally {
    slot?.release();
  }
}

/**
 * Run a Plaud command and parse stdout as JSON (for the structured commands such as `files`, `me`).
 * Callers of the Markdown/plain-text commands (`transcript`, `summary`) use runPlaudCommand directly.
 * Returns the parsed JSON or a normalized error string suitable as a tool result.
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
