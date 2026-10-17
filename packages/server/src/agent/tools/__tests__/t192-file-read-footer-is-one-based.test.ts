// ════════════════════════════════════════════════════════════════════════════════
// t192 D13 — THE `file_read` FOOTER COUNTS LINES THE WAY THE GUTTER DOES.
//
// The page rows carry 1-based gutters ("4<TAB>…"), but the footer printed the loop's 0-based indexes:
// a read of lines 4-5 said "Read lines 3-4". The "continue" offset is a count of lines to skip, so it
// stays as it is. These drive the real handler on a real file and compare the footer to the gutter
// the page itself shows.
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
import type { ToolCall } from '@dojo/shared';

const AGENT = 'agent-1';
let tmpDir: string;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 't192-d13-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function read(args: Record<string, unknown>): Promise<string> {
  return runWithToolCallId(AGENT, 't192-read', async () => {
    attachCallCapability(mintCallCapability({
      agentId: AGENT, tool: 'file_read', callId: 't192-read',
      grants: grantsForCall(AGENT, effectsFor('file_read'), args),
    }));
    const out = await fsHandlers['file_read']({
      agentId: AGENT, name: 'file_read', args, callId: 't192-read',
      toolCall: { id: 't192-read', name: 'file_read', input: args } as unknown as ToolCall,
    });
    return out.content;
  });
}

function tenLines(): string {
  const file = path.join(tmpDir, 'ten.txt');
  fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `row ${i + 1}`).join('\n'));
  return file;
}

/** The first and last gutter numbers the page itself shows. */
function gutterRange(out: string): [number, number] {
  const nums = out.split('\n').map((l) => /^\s*(\d+)\t/.exec(l)?.[1]).filter((n): n is string => !!n).map(Number);
  return [nums[0]!, nums[nums.length - 1]!];
}

describe('t192 D13: the footer says the lines the gutter shows', () => {
  it('a middle page (offset 3, limit 2) shows gutter 4-5 and the footer says 4-5', async () => {
    const out = await read({ path: tenLines(), offset: 3, limit: 2 });
    expect(gutterRange(out)).toEqual([4, 5]);
    expect(out).toContain('[Read lines 4-5 of 10 total. 5 more lines remain.');
    // the continue instruction still skips what was read: offset is a count of lines to skip
    expect(out).toContain('offset=5,');
  });

  it('the first page (no offset) says lines 1-N, never 0-N', async () => {
    const out = await read({ path: tenLines(), limit: 4 });
    expect(gutterRange(out)).toEqual([1, 4]);
    expect(out).toContain('[Read lines 1-4 of 10 total.');
    expect(out).not.toMatch(/Read lines 0-/);
  });

  it('the end-of-file marker names the last page by the gutter too', async () => {
    const out = await read({ path: tenLines(), offset: 6 });
    expect(gutterRange(out)).toEqual([7, 10]);
    expect(out).toContain('[End of file. Read lines 7-10 of 10 total.]');
  });

  it('following the footer\'s own continue offset lands on the next gutter line (no gap, no repeat)', async () => {
    const first = await read({ path: tenLines(), offset: 0, limit: 3 });
    const next = /offset=(\d+),/.exec(first)![1]!;
    const second = await read({ path: tenLines(), offset: Number(next), limit: 3 });
    expect(gutterRange(first)[1] + 1).toBe(gutterRange(second)[0]);
  });
});
