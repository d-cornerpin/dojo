// ════════════════════════════════════════
// Agent SDK Auth — CLI detection and connection verification
// ════════════════════════════════════════

import { execSync } from 'node:child_process';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-sdk-auth');

/**
 * Check if the Claude Code CLI is installed (which ships with the Agent SDK).
 */
export function isClaudeCliInstalled(): boolean {
  try {
    execSync('which claude', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the installed Claude Code CLI version.
 */
export function getClaudeCliVersion(): string | null {
  try {
    const result = execSync('claude --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Check if the Agent SDK npm package is available for import.
 */
export function isSdkPackageAvailable(): boolean {
  try {
    require.resolve('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify Agent SDK auth by running a minimal test query.
 * Returns account info if authenticated, null if not.
 */
export async function checkSdkAuth(): Promise<{ authenticated: boolean; error?: string }> {
  if (!isClaudeCliInstalled()) {
    return { authenticated: false, error: 'Claude Code CLI not installed' };
  }

  try {
    // Dynamic import to avoid crashing if SDK not installed
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { query } = sdk;

    // Run a minimal query to test auth
    for await (const message of query({
      prompt: 'Say exactly "ok" and nothing else.',
      options: {
        model: 'haiku',
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'bypassPermissions' as any,
      },
    })) {
      if (message.type === 'assistant') {
        // If we got a response, auth works
        logger.info('Agent SDK auth verified');
        return { authenticated: true };
      }
      if (message.type === 'auth_status' && (message as any).error) {
        return { authenticated: false, error: (message as any).error };
      }
    }

    return { authenticated: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Agent SDK auth check failed', { error: msg });
    return { authenticated: false, error: msg };
  }
}
