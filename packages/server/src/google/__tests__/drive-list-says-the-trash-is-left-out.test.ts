// C5 (R6, label never hide): a Drive search leaves the Trash out by default; the tool description and the
// zero-result line say so and say how to include it. The default itself is unchanged (see drive-list-skips-trashed-files).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { files: [] as unknown[] } }));
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));
vi.mock('../accounts.js', () => ({ resolveGoogleAccountForRead: () => ({ account: { id: 'acct', email: 'a@example.invalid' }, labelAccount: false }) }));

const { executeGoogleReadTool, googleReadToolDefinitions } = await import('../tools-read.js');

beforeEach(() => googleRead.mockClear());

describe('Drive searches label the Trash exclusion', () => {
  it('both drive_list and user_drive_list descriptions say the Trash is left out and how to include it', () => {
    for (const name of ['drive_list', 'user_drive_list']) {
      const d = googleReadToolDefinitions.find((t) => t.name === name)!.description;
      expect(d, name).toMatch(/Trash are left out/);
      expect(d, name).toContain('trashed = true');
    }
  });

  it('a zero-result search says the Trash was not searched and how to search it', async () => {
    const out = await executeGoogleReadTool('drive_list', { query: 'budget' }, 'agent-1', 'Agent');
    expect(out).toMatch(/No files found/);
    expect(out).toMatch(/Trash.*left out/);
    expect(out).toContain('trashed = true');
  });

  it('a search that already asks for the Trash does not get the note', async () => {
    const out = await executeGoogleReadTool('drive_list', { query: 'trashed = true' }, 'agent-1', 'Agent');
    expect(out).not.toMatch(/left out/);
  });
});
