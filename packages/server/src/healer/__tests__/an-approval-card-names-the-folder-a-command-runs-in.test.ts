// An approval card for a held delete names the real folder the command runs in: the call's own cwd when
// it is an existing folder, else the folder the Dojo itself runs in.
import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

const { describeHeldAction } = await import('../approval-routing.js');

const say = (tool: string, args: Record<string, unknown>) => describeHeldAction(tool, JSON.stringify(args));
const GONE = 'Deleted files do not go to the Trash and cannot be brought back.';

describe('an approval card names the folder a command runs in', () => {
  it('a relative target names the folder the call asked for', () => {
    expect(say('exec', { argv: ['rm', '-rf', 'build'], cwd: os.tmpdir() }))
      .toBe(`Delete "build" in ${os.tmpdir()}, including everything inside. ${GONE}`);
  });

  it('a shell line names it too', () => {
    expect(say('shell', { script: 'rm old.log', cwd: os.tmpdir() }))
      .toBe(`Delete "old.log" in ${os.tmpdir()}. ${GONE}`);
  });

  it("with no folder given it names the Dojo's own folder", () => {
    const t = say('exec', { argv: ['rm', 'build'] });
    expect(t).not.toContain('the folder this command runs from');
    expect(t).toMatch(/^Delete "build" in \//);
  });

  it('a folder that does not exist is not named, because the call would not run there', () => {
    const t = say('exec', { argv: ['rm', 'build'], cwd: '/no/such/folder-for-this-test' });
    expect(t).not.toContain('/no/such/folder-for-this-test');
  });
});
