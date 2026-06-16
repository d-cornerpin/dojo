// Regression test for the sub-agent SOUL-rules carry-through (remediation
// C10 / Flow 7): the owner's `# Rules` from SOUL.md must extract cleanly so
// it can be passed to spawned sub-agents.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMarkdownSection } from '../assembler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOUL_TEMPLATE = path.join(__dirname, '../../../../../templates/SOUL.md');

describe('extractMarkdownSection', () => {
  it('extracts a named section body and stops at the next header', () => {
    const md = '# Identity\nYou are X.\n\n# Rules\n- rule one\n- rule two\n\n# Vault\nkeep stuff';
    const rules = extractMarkdownSection(md, 'Rules');
    expect(rules).toContain('- rule one');
    expect(rules).toContain('- rule two');
    expect(rules).not.toContain('You are X'); // earlier section excluded
    expect(rules).not.toContain('keep stuff'); // later section excluded
  });

  it('is case-insensitive on the header and returns empty for a missing one', () => {
    const md = '## rules\n- a\n';
    expect(extractMarkdownSection(md, 'Rules')).toContain('- a');
    expect(extractMarkdownSection(md, 'Nonexistent')).toBe('');
  });

  it('pulls the real SOUL.md Rules section (so sub-agents inherit owner rules)', () => {
    if (!fs.existsSync(SOUL_TEMPLATE)) return; // template path may differ in CI; skip gracefully
    const soul = fs.readFileSync(SOUL_TEMPLATE, 'utf-8');
    const rules = extractMarkdownSection(soul, 'Rules');
    expect(rules.length).toBeGreaterThan(0);
    expect(rules).not.toContain('# Identity'); // identity stays with the primary
  });
});
