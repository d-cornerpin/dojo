// ════════════════════════════════════════════════════════════════════════════
// `file_append` — THE DEFAULT PATH AGAINST AN EXISTING NON-EMPTY FILE.
//
// PHASE-5 T12. The case no test covered: `ensure_newline` left at its default
// against a file that already has bytes in it. That is the path the tool's own
// description recommends — building a long doc one section at a time "instead
// of the read-modify-rewrite cycle" — and it is the one the exit battery found
// refused (`edit-existing-doc`, run `bmse5ef28xy`; T11 report §5).
//
// ── WHY THE GRANTS COME FROM THE DECLARATION, NEVER FROM A LIST HERE ──
// The capability is the ORACLE. `grantsForCall(agentId, effectsFor('file_append'),
// args)` resolves the tool's OWN declaration exactly as the executor's gate loop
// resolves it before dispatch, so a declaration that does not describe what the
// handler performs fails HERE, in a unit test, instead of in a battery two hours
// long — and a hand-written grant list would let this file pass while the real
// declaration was wrong. `file-patch.test.ts` established this shape; this file
// is its sibling for the tool that was found short.
//
// ── THE SEPARATOR IS THE ASSERTION, NOT ONLY THE ABSENCE OF AN ERROR ──
// The peek sits inside `try { } catch { }` that reads any failure as "the file
// is not there". So a refusal on the metadata probe alone would NOT error — the
// separator would just silently vanish. Asserting the bytes on disk is what
// catches that half; asserting the result string is not an error catches the
// other. Both halves are needed, and both are here.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// auditLog hits the DB; mock the connection so tests don't need one.
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({ run: () => ({}), get: () => ({}), all: () => [] }),
    exec: () => ({}),
    transaction: (fn: () => unknown) => () => fn(),
  }),
}));

vi.mock('../../gateway/ws.js', () => ({
  broadcast: () => { /* no-op */ },
}));

import { fsHandlers } from '../tools/cat/fs.js';
import { runWithToolCallId } from '../turn-state.js';
import {
  attachCallCapability, mintCallCapability, grantsCover, type ResourceGrant,
} from '../effects/capability.js';
import { grantsForCall } from '../effects/scopes.js';
import { effectsFor } from '../tools/registry.js';
import type { ToolCall } from '@dojo/shared';

const AGENT = 'agent-1';

/**
 * Drive the dispatch entry inside the SAME per-call context production opens,
 * carrying the grants the gate loop would have minted for these arguments.
 */
function append(args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  return runWithToolCallId(AGENT, 'file-append-test', async () => {
    attachCallCapability(mintCallCapability({
      agentId: AGENT, tool: 'file_append', callId: 'file-append-test',
      grants: grantsForCall(AGENT, effectsFor('file_append'), args),
    }));
    return fsHandlers['file_append']({
      agentId: AGENT, name: 'file_append', args, callId: 'file-append-test',
      toolCall: { id: 'file-append-test', name: 'file_append', input: args } as unknown as ToolCall,
    });
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-append-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('file_append at its DEFAULT setting against an existing non-empty file', () => {
  it('APPENDS, and adds the separator its own description promises', async () => {
    // THE CLAUSE THE BATTERY EARNED. `ensure_newline` is not passed at all —
    // the default — and the target already holds bytes with no trailing LF,
    // which is the shape that makes the handler look at the last byte.
    const file = path.join(tmpDir, 'notes.md');
    fs.writeFileSync(file, '# Notes\nfirst section');

    const out = await append({ path: file, content: '## Section 2\nmore' });

    expect(out.isError, out.content).toBe(false);
    expect(out.content).toMatch(/^Appended \d+ bytes to /);
    expect(fs.readFileSync(file, 'utf-8')).toBe('# Notes\nfirst section\n## Section 2\nmore');
  });

  it('…and adds NO second separator when the file already ends in a newline', async () => {
    // Same peek, opposite answer: the read still happens, and the bytes prove
    // the tool read them rather than guessing.
    const file = path.join(tmpDir, 'notes.md');
    fs.writeFileSync(file, 'first section\n');

    const out = await append({ path: file, content: 'second section\n' });

    expect(out.isError, out.content).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('first section\nsecond section\n');
  });

  it('creates an absent file with no leading separator', async () => {
    const file = path.join(tmpDir, 'fresh.md');

    const out = await append({ path: file, content: 'the first bytes' });

    expect(out.isError, out.content).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('the first bytes');
  });

  it('appends to an EMPTY file with no leading separator', async () => {
    const file = path.join(tmpDir, 'empty.md');
    fs.writeFileSync(file, '');

    const out = await append({ path: file, content: 'the first bytes' });

    expect(out.isError, out.content).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('the first bytes');
  });

  it('ensure_newline=false appends the exact bytes verbatim', async () => {
    const file = path.join(tmpDir, 'log.txt');
    fs.writeFileSync(file, 'line one');

    const out = await append({ path: file, content: '|line two', ensure_newline: false });

    expect(out.isError, out.content).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('line one|line two');
  });
});

describe('the corrected declaration states the read, and widens nothing', () => {
  function grantsFor(args: Record<string, unknown>): ResourceGrant[] {
    return grantsForCall(AGENT, effectsFor('file_append'), args);
  }

  it('covers BOTH directions on the path the call named — the write and the peek', () => {
    const file = path.join(tmpDir, 'notes.md');
    const grants = grantsFor({ path: file, content: 'x' });
    expect(grantsCover(grants, { op: 'fs_write', path: file, real: file }), 'the append itself').toBe(true);
    expect(grantsCover(grants, { op: 'fs_read', path: file, real: file }), 'the trailing-byte peek').toBe(true);
    expect(grantsCover(grants, { op: 'fs_stat', path: file, real: file }), 'the size probe').toBe(true);
  });

  it('and it is still ONE file: a neighbour is refused in both directions', () => {
    const file = path.join(tmpDir, 'notes.md');
    const neighbour = path.join(tmpDir, 'not-declared.md');
    const grants = grantsFor({ path: file, content: 'x' });
    expect(grantsCover(grants, { op: 'fs_read', path: neighbour, real: neighbour })).toBe(false);
    expect(grantsCover(grants, { op: 'fs_write', path: neighbour, real: neighbour })).toBe(false);
    // A read is not a licence to delete, either.
    expect(grantsCover(grants, { op: 'fs_delete', path: file, real: file })).toBe(false);
  });

  it('refuses a path the call never named, through the handler itself', async () => {
    // The lock is still a lock: the grants come from `args.path`, so a handler
    // reaching anywhere else is refused. Driven rather than asserted about.
    const declared = path.join(tmpDir, 'declared.md');
    const other = path.join(tmpDir, 'other.md');
    fs.writeFileSync(other, 'untouched');

    await runWithToolCallId(AGENT, 'file-append-reach', async () => {
      attachCallCapability(mintCallCapability({
        agentId: AGENT, tool: 'file_append', callId: 'file-append-reach',
        grants: grantsForCall(AGENT, effectsFor('file_append'), { path: declared, content: 'x' }),
      }));
      const out = await fsHandlers['file_append']({
        agentId: AGENT, name: 'file_append', args: { path: other, content: 'reached' },
        callId: 'file-append-reach',
        toolCall: { id: 'file-append-reach', name: 'file_append', input: {} } as unknown as ToolCall,
      });
      expect(out.isError, 'a resource this call never declared').toBe(true);
      expect(out.content).toContain('beyond the resources this call declared');
    });

    expect(fs.readFileSync(other, 'utf-8')).toBe('untouched');
  });
});
