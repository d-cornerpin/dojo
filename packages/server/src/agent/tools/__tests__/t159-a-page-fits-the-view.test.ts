// ════════════════════════════════════════════════════════════════════════════════
// t159 H (v3.3.3 run 7) — A FILE READ HANDS THE AGENT A PAGE IT CAN SEE WHOLE.
//
// The witness (S4 L3): `file_read` returned "lines 143-718 of 901", 243,752 chars, with its
// "N more lines remain; continue at offset N" footer at the END. The assembler shows the agent at
// most V2_MAX_TOOL_RESULT_TOKENS of any one tool result, kept from the head — about 60,000 chars.
// The needle and the footer were never in view and the agent answered "I read the whole log … there
// is no entry". Two numbers for one fact. The page is now sized to the view's own number
// (`memory/tool-result-view.ts`); the assembler's cap stays as the backstop for unpaged output and its
// note says what was kept.
//
// Driven through the real handler on a real file, and through the assembler's real cap — records,
// not prose.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({ run: () => ({}), get: () => ({}), all: () => [] }),
    exec: () => ({}),
    transaction: (fn: () => unknown) => () => fn(),
  }),
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

import { fsHandlers } from '../cat/fs.js';
import { runWithToolCallId } from '../../turn-state.js';
import { attachCallCapability, mintCallCapability } from '../../effects/capability.js';
import { grantsForCall } from '../../effects/scopes.js';
import { effectsFor } from '../registry.js';
import { applyMaxResultTokensCap } from '../index.js';
import { capLargeToolResultStrings } from '../../../memory/assembler.js';
import { V2_MAX_TOOL_RESULT_TOKENS, TOOL_RESULT_VIEW_CHARS, capToolResultView } from '../../../memory/tool-result-view.js';
import { estimateTokens } from '../../../memory/budget.js';
import { toolDefinitions } from '../definitions.js';
import type { ToolCall } from '@dojo/shared';

const AGENT = 'agent-1';
let tmpDir: string;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 't159-h-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function read(args: Record<string, unknown>): Promise<string> {
  return runWithToolCallId(AGENT, 't159-read', async () => {
    attachCallCapability(mintCallCapability({
      agentId: AGENT, tool: 'file_read', callId: 't159-read',
      grants: grantsForCall(AGENT, effectsFor('file_read'), args),
    }));
    const out = await fsHandlers['file_read']({
      agentId: AGENT, name: 'file_read', args, callId: 't159-read',
      toolCall: { id: 't159-read', name: 'file_read', input: args } as unknown as ToolCall,
    });
    return out.content;
  });
}

/** The measured shape: ~900 lines of ~270 chars, a needle on the way. */
function bigLog(): { file: string; lines: string[]; needleLine: number } {
  const lines: string[] = [];
  for (let i = 1; i <= 901; i++) lines.push(`entry ${String(i).padStart(4, '0')} ${'x'.repeat(250)}`);
  const needleLine = 777;
  lines[needleLine - 1] = `entry ${needleLine} NEEDLE-4f9c ${'y'.repeat(240)}`;
  const file = path.join(tmpDir, 'ledger.log');
  fs.writeFileSync(file, lines.join('\n'));
  return { file, lines, needleLine };
}

/** What the model's view does to one tool result: the assembler's real cap over a stored tool row. */
function throughTheView(content: string): string {
  const row = {
    id: 'm1', agentId: AGENT, role: 'tool', tokenCount: null,
    content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'tc1', content }]),
  };
  const [out] = capLargeToolResultStrings([row as never]);
  return (JSON.parse(out.content) as Array<{ content: string }>)[0].content;
}

const nextOffset = (page: string): number | null => {
  const m = page.match(/To continue: file_read\(path="[^"]+", offset=(\d+)/);
  return m ? Number(m[1]) : null;
};

describe('t159 H: file_read sizes its page to what the view will show', () => {
  it('a file larger than one view: the page fits under the cap, ends in its continue-at footer, and the cap never fires on it', async () => {
    const { file } = bigLog();
    const page = await read({ path: file });
    expect(page.length).toBeLessThanOrEqual(TOOL_RESULT_VIEW_CHARS);
    expect(estimateTokens(page)).toBeLessThanOrEqual(V2_MAX_TOOL_RESULT_TOKENS);
    expect(page).toMatch(/more lines remain\.\n To continue: file_read\(path="[^"]+", offset=\d+, limit=\d+\)/);
    // The view shows it whole: the footer is the end of what the agent sees, and nothing was cut.
    expect(throughTheView(page)).toBe(page);
    expect(applyMaxResultTokensCap('file_read', page)).toBe(page);
  });

  it('paging to the end visits every line exactly once, and the needle is found', async () => {
    const { file, lines, needleLine } = bigLog();
    const seen: number[] = [];
    let offset: number | null = 0;
    let pages = 0;
    let sawNeedle = false;
    while (offset !== null) {
      const page = await read({ path: file, offset });
      const viewed = throughTheView(page);
      expect(viewed).toBe(page);   // every page, whole, in view
      for (const row of page.split('\n')) {
        const m = row.match(/^\s*(\d+)\t/);
        if (m) seen.push(Number(m[1]));
        if (row.includes('NEEDLE-4f9c')) sawNeedle = true;
      }
      offset = nextOffset(page);
      pages++;
      expect(pages).toBeLessThan(50);
    }
    expect(seen).toEqual(Array.from({ length: lines.length }, (_, i) => i + 1));
    expect(sawNeedle, `line ${needleLine} was never in a viewed page`).toBe(true);
    expect(pages).toBeGreaterThan(1);
  });

  it('the page fits even when the footer\'s own line is long (a long path)', async () => {
    const deep = path.join(tmpDir, 'a'.repeat(90), 'b'.repeat(90));
    fs.mkdirSync(deep, { recursive: true });
    const file = path.join(deep, 'big.log');
    fs.writeFileSync(file, Array.from({ length: 3000 }, (_, i) => `row ${i} ${'z'.repeat(120)}`).join('\n'));
    const page = await read({ path: file });
    expect(page.length).toBeLessThanOrEqual(TOOL_RESULT_VIEW_CHARS);
    expect(throughTheView(page)).toBe(page);
  });

  it('file_read\'s own declared cap is the same number as the view (no second figure)', () => {
    const def = toolDefinitions.find((t) => t.name === 'file_read')!;
    expect(def.maxResultTokens).toBe(V2_MAX_TOOL_RESULT_TOKENS);
  });
});

describe('t159 H: the backstop for unpaged output says what it kept', () => {
  it('an oversized result keeps its head and names the kept size and the whole size', () => {
    const big = 'q'.repeat(TOOL_RESULT_VIEW_CHARS * 3);
    const viewed = throughTheView(big);
    expect(viewed.startsWith('q'.repeat(1000))).toBe(true);
    expect(viewed).toMatch(/only the first ~\d+ chars \(~15000 tokens\) of this 180000-char \(~45000-token\) result were kept/);
    expect(viewed).toContain('the rest is NOT shown');
    expect(viewed).not.toMatch(/tokens truncated/);   // the old wording said how much was LOST, never what was kept
  });

  it('the shared cap is the identity within the view, and the same note comes from the in-place door', () => {
    const fits = 'w'.repeat(TOOL_RESULT_VIEW_CHARS);
    expect(capToolResultView(fits, 'hint')).toBe(fits);
    expect(capToolResultView(fits + 'w', 'hint')).toMatch(/only the first ~\d+ chars/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ONE FIGURE, COUNTED IN BOTH DIRECTIONS over comment-stripped shipped source.
// ════════════════════════════════════════════════════════════════════════════════
describe('t159 H: the per-result view size has one source, and every site reads it', () => {
  const SRC = path.resolve(__dirname, '..', '..', '..');
  const strip = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
  const shipped = (): Array<{ rel: string; code: string }> => {
    const out: Array<{ rel: string; code: string }> = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['__tests__', 'node_modules', 'dist', 'migrations'].includes(e.name)) walk(full); }
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push({ rel: path.relative(SRC, full), code: strip(fs.readFileSync(full, 'utf8')) });
      }
    };
    walk(SRC);
    return out;
  };

  it('the figure is declared once; the assembler\'s two cap sites call the shared cap; file_read holds no char figure of its own', () => {
    const files = shipped();
    const declarations = files.filter((f) => /\bV2_MAX_TOOL_RESULT_TOKENS\s*=\s*\d/.test(f.code)).map((f) => f.rel);
    expect(declarations).toEqual(['memory/tool-result-view.ts']);

    const assembler = files.find((f) => f.rel === 'memory/assembler.ts')!.code;
    expect(assembler.match(/\bcapToolResultView\(/g)?.length).toBe(2);
    expect(assembler).not.toMatch(/tokens truncated/);

    const fsCode = files.find((f) => f.rel === 'agent/tools/cat/fs.ts')!.code;
    expect(fsCode).toMatch(/TOOL_RESULT_VIEW_CHARS/);
    expect(fsCode).not.toMatch(/\b\d{3}_000\b/);   // no 240_000-style page figure

    const defs = files.find((f) => f.rel === 'agent/tools/definitions.ts')!.code;
    expect(defs).not.toMatch(/maxResultTokens:\s*60000/);
  });
});
