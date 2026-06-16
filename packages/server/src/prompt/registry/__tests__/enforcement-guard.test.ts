// R8 enforcement guard — the hard governance rule (David's "hard rule moving
// forward"): engine injection into the assembled context happens ONLY through
// the registry. This test greps the server source for raw injection patterns
// outside a small allow-list and FAILS the build if any appear, so a new stray
// injection cannot silently re-accumulate the scatter the registry eliminated.
//
// Allow-list (the only places these patterns legitimately live):
//   - prompt/registry/*          — the registry + its injection helpers
//   - prompt/assembler.ts        — system render fns (uses emit/join, not these)
//   - memory/assembler.ts        — the message-base producer + integrity pass
//   - agent/v2/engine-message.ts — pushEngineMessage, the single channel
//
// Comment lines are skipped so a doc mention of a pattern doesn't trip it.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const ALLOWED_PREFIXES = [
  'prompt/registry/',
  'prompt/assembler.ts',
  'memory/assembler.ts',
  'agent/v2/engine-message.ts',
];

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'pushEngineMessage() call', re: /\bpushEngineMessage\s*\(/ },
  { name: 'raw systemPrompt += (system-prompt append)', re: /systemPrompt\s*\+=/ },
  { name: "raw messages.push({ role: 'user' }) (engine injection)", re: /messages\.push\(\s*\{\s*role:\s*['"]user['"]/ },
];

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collectTsFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('R8 — engine injection only via the registry (enforcement guard)', () => {
  it('finds no raw injection patterns outside the allow-list', () => {
    const files = collectTsFiles(SRC_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (rel.endsWith('.test.ts') || rel.includes('__tests__/')) continue;
      if (ALLOWED_PREFIXES.some((p) => rel === p || rel.startsWith(p))) continue;

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        for (const { name, re } of FORBIDDEN) {
          if (re.test(line)) violations.push(`${rel}:${i + 1} — ${name}`);
        }
      });
    }

    // If this fails: route the injection through the registry
    // (injectRegistryMessage / appendSystemHint), or add the file to the
    // allow-list with a documented reason. See DOJO-PROMPT-REGISTRY-CONTRACT.md.
    expect(violations).toEqual([]);
  });
});
