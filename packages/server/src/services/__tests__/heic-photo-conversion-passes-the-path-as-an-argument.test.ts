// The HEIC converter hands the file path to sips as one argument. No shell ever reads the name.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const execMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: execFileMock,
  execSync: execMock,
}));

const { convertHeicToJpeg } = await import('../imessage-run.js');

describe('HEIC photo conversion', () => {
  beforeEach(() => {
    execFileMock.mockReset().mockReturnValue('');
    execMock.mockReset().mockReturnValue('');
  });

  it('passes a hostile-looking file name as a plain argument and never uses a shell', () => {
    const src = '/tmp/fake/Receipt $5 `x` $(touch pwned).HEIC';
    convertHeicToJpeg(src, '/tmp/fake/out.jpg');
    expect(execMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [program, argv] = execFileMock.mock.calls[0];
    expect(program).toBe('/usr/bin/sips');
    expect(argv[argv.indexOf('jpeg') + 1]).toBe(src);
    expect(argv[argv.indexOf('--out') + 1]).toBe('/tmp/fake/out.jpg');
  });

  it('still throws when the conversion fails', () => {
    execFileMock.mockImplementation(() => { throw new Error('sips failed'); });
    expect(() => convertHeicToJpeg('/tmp/fake/a.HEIC', '/tmp/fake/a.jpg')).toThrow();
  });
});
