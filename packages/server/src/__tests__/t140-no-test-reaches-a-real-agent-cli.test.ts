// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 2 — THE PLANTED ATTEMPTS. Every way a test could start the real Claude CLI fails
// loudly, by name, and no worker carries a credential a started child could use.
//
// The nets live in `vitest.setup.ts` (read its block for why). Each clause below plants one
// attempt that a careless test, or a per-file mock that misses, could make — and asserts the
// attempt throws the net's own words rather than launching anything.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NET = /TEST NET: a test tried to start the real Claude CLI/;

describe('t140 round 2 — no test can start a real Agent CLI', () => {
  it('the package, imported as any test would, is the suite-wide throwing mock', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    let message = '';
    try { sdk.query({ prompt: 'x', options: {} } as never); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(NET);
    // The PACKAGE net answered, not the spawn net behind it: the spawn net names the call it
    // refused, and a real `query()` would have reached it.
    expect(message).not.toMatch(/child_process\./);
  });

  it('the REAL package (importActual — the shape of a mock that misses) still cannot spawn the CLI', async () => {
    const real = await vi.importActual<typeof import('@anthropic-ai/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');
    let failure: unknown = null;
    try {
      for await (const _m of real.query({ prompt: 'say ok', options: { maxTurns: 1 } } as never)) { /* never reached */ }
    } catch (e) { failure = e; }
    expect(String(failure instanceof Error ? failure.message : failure)).toMatch(NET);
  });

  it('the production transport, dialing for real, fails loudly instead of launching anything', async () => {
    const { callAnthropicViaSdk } = await import('../providers/anthropic-sdk.js');
    await expect(callAnthropicViaSdk({
      agentId: 'agent-net', apiModelId: 'sonnet', systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
    } as never)).rejects.toThrow(NET);
  });

  it.each(['spawn', 'spawnSync', 'execSync', 'execFile', 'execFileSync', 'exec'] as const)(
    'child_process.%s refuses a command line naming the Claude CLI', (fn) => {
      const call = (childProcess as unknown as Record<string, (...a: unknown[]) => unknown>)[fn];
      expect(() => call(fn.startsWith('exec') && !fn.startsWith('execFile') ? 'claude --version' : 'claude', ['--version'])).toThrow(NET);
    },
  );

  it('…and still runs an ordinary command (the net is narrow, not a blanket ban)', () => {
    expect(String(childProcess.execFileSync('node', ['-e', 'process.stdout.write("ok")']))).toBe('ok');
  });

  it('no worker carries a provider credential or a coding-agent session variable', () => {
    const leaked = Object.keys(process.env).filter((k) => /^(CLAUDE_CODE_|CLAUDECODE$|ANTHROPIC_|OPENAI_|OPENROUTER_|DEEPSEEK_)/.test(k));
    expect(leaked).toEqual([]);
  });

  it('a file whose subject is the transport scripts query() through the ONE suite mock, and nothing else does it per file', async () => {
    const g = globalThis as { __scriptedAgentSdk?: unknown };
    expect(g.__scriptedAgentSdk, 'a script never leaks in from another file').toBeUndefined();
    g.__scriptedAgentSdk = { query: () => 'scripted' };
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      expect(sdk.query({ prompt: 'x', options: {} } as never)).toBe('scripted');
    } finally { g.__scriptedAgentSdk = undefined; }

    // Census: a per-file mock of the package is the shape measured being bypassed. Comments are
    // stripped first, so a file that only DESCRIBES the old pattern does not count.
    const SRC = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
        if (!/\.test\.tsx?$/.test(e.name)) continue;
        const code = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
        if (/vi\.(do)?mock\(\s*['"`]@anthropic-ai\/claude-agent-sdk['"`]/.test(code)) offenders.push(path.relative(SRC, full));
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
