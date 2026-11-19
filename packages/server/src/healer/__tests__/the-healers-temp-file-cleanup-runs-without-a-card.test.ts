// A Healer `rm` strictly inside a temporary folder is meant to run without asking the owner,
// and the check must read the call the way `exec` actually carries it: argv.
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { evaluateScratchZoneAutoApprove } from '../approval-routing.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healer-scratch-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the healer's temp file cleanup", () => {
  it('an rm of a temp folder in argv form is auto-approved', () => {
    const decision = evaluateScratchZoneAutoApprove('exec', { argv: ['rm', '-rf', dir] });
    expect(decision).not.toBeNull();
    expect(decision?.command).toBe(`rm -rf ${dir}`);
  });

  it('an rm outside the temp folders still holds', () => {
    expect(evaluateScratchZoneAutoApprove('exec', { argv: ['rm', '-rf', '/opt/not-a-scratch-folder'] })).toBeNull();
  });

  it('an argv element with a space holds', () => {
    expect(evaluateScratchZoneAutoApprove('exec', { argv: ['rm', path.join(dir, 'a b')] })).toBeNull();
  });

  it('one target outside the temp folders makes the whole call hold', () => {
    expect(evaluateScratchZoneAutoApprove('exec', { argv: ['rm', '-rf', dir, '/opt/elsewhere'] })).toBeNull();
  });
});
