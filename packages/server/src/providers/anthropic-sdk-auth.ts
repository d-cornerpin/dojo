// Agent SDK auth: CLI detection and connection verification.

import { execSync } from 'node:child_process';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-sdk-auth');

export function isClaudeCliInstalled(): boolean {
  try {
    execSync('which claude', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

export function getClaudeCliVersion(): string | null {
  try {
    const result = execSync('claude --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return result.trim();
  } catch {
    return null;
  }
}

export function isSdkPackageAvailable(): boolean {
  try {
    require.resolve('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

/** Verifies Agent SDK auth by running a minimal one-turn query. */
export async function checkSdkAuth(): Promise<{ authenticated: boolean; error?: string }> {
  if (!isClaudeCliInstalled()) {
    return { authenticated: false, error: 'Claude Code CLI not installed' };
  }

  try {
    // Dynamic import so a missing SDK package does not crash at load.
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { query } = sdk;

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
