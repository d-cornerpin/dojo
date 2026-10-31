// ════════════════════════════════════════════════════════════════════════════
// A MODEL-SUPPLIED WORD IS A VALUE ON THE PLAUD COMMAND LINE, NOT AN OPTION
//
// ROOT CAUSE: tools-read.ts pushes args.query / args.recording_id / args.from /
// args.to straight into the CLI's argument list, and nothing checks them. A
// recording_id like "--help" or "-x" is read by the CLI as an option, and a
// missing or non-text value (a number, null) makes execFile throw. Real
// recording ids are plain letters and digits and never start with a dash.
//
// THESE CLAUSES HOLD: a dash-prefixed word is refused and never reaches the CLI;
// a missing or non-text word is refused as "is required (text)"; a plain word
// still runs through unchanged.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── The CLI call, faked at the client boundary ──
vi.mock('../client.js', () => ({
  runPlaudCommand: vi.fn(async () => ({ ok: true, stdout: '', stderr: '', needsReauth: false })),
  runPlaudJson: vi.fn(async () => ({ ok: false })),
}));

const { executePlaudTool } = await import('../tools-read.js');
const { runPlaudCommand } = await import('../client.js');
const cli = vi.mocked(runPlaudCommand);

beforeEach(() => { vi.clearAllMocks(); });

describe('a Plaud word is a value, not an option', () => {
  it('refuses a dash-prefixed recording id and never reaches the CLI', async () => {
    const out = await executePlaudTool('plaud_get_transcript', { recording_id: '--help' });

    expect(out).toBe('Error: recording_id cannot start with a dash.');
    expect(cli).not.toHaveBeenCalled();
  });

  it('refuses a non-text recording id as required (text)', async () => {
    const out = await executePlaudTool('plaud_get_transcript', { recording_id: 42 });

    expect(out).toContain('is required');
    expect(cli).not.toHaveBeenCalled();
  });

  it('refuses a missing recording id as required (text)', async () => {
    const out = await executePlaudTool('plaud_get_transcript', {});

    expect(out).toContain('is required');
    expect(cli).not.toHaveBeenCalled();
  });

  it('refuses a dash-prefixed search query and never reaches the CLI', async () => {
    const out = await executePlaudTool('plaud_search_recordings', { query: '-all' });

    expect(out).toContain('cannot start with a dash');
    expect(cli).not.toHaveBeenCalled();
  });

  it('refuses a dash-prefixed from filter and never reaches the CLI', async () => {
    const out = await executePlaudTool('plaud_search_recordings', { query: 'budget', from: '--x' });

    expect(out).toContain('cannot start with a dash');
    expect(cli).not.toHaveBeenCalled();
  });

  it('runs a plain search query through to the CLI', async () => {
    await executePlaudTool('plaud_search_recordings', { query: 'budget' });

    expect(cli).toHaveBeenCalledWith(['search', 'budget'], expect.anything());
  });

  it('passes a normal recording id straight through to the CLI', async () => {
    await executePlaudTool('plaud_get_transcript', { recording_id: 'abc123' });

    expect(cli).toHaveBeenCalledWith(['transcript', 'abc123'], expect.anything());
  });
});
