// t163 B — `drive_list` TEACHES A QUERY DRIVE ACCEPTS.
//
// MEASURED (Run 9, S3): the tool's own parameter text gave the example `name contains report`,
// and the handler passed the query to Drive's `q` raw. Drive's `q` wants quoted values
// (`name contains 'report'`), so both of the model's calls — the taught form, and a bare word it
// tried next — came back "Invalid Value".
//
//   * the description's examples are valid Drive syntax;
//   * a query with no Drive operator (a bare word or phrase) is sent as
//     `fullText contains '<term>'`, with `'` and `\` escaped;
//   * a query that already has an operator passes through UNCHANGED.
//
// Driven through the real tool door (`executeGoogleReadTool`), reading the `q` it puts on the
// wire; only the HTTP client and the account resolver are doubles.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { files: [] } }));
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: () => ({ account: { id: 'acct-1', email: 'agent@example.invalid' }, labelAccount: false }),
}));

const { executeGoogleReadTool, googleReadToolDefinitions } = await import('../tools-read.js');

/** The `q` the handler sent to Drive for this query. */
async function sentQ(args: Record<string, unknown>): Promise<string> {
  googleRead.mockClear();
  await executeGoogleReadTool('drive_list', args, 'agent-1', 'Agent');
  const url = String(googleRead.mock.calls[0][0]);
  return new URL(url).searchParams.get('q') ?? '';
}

describe('t163 B — a bare term becomes a full-text search', () => {
  beforeEach(() => googleRead.mockClear());

  it('a single word is sent as fullText contains \'<word>\'', async () => {
    expect(await sentQ({ query: 'ORCHID' })).toBe("fullText contains 'ORCHID'");
  });

  it('a phrase is one term, not several', async () => {
    expect(await sentQ({ query: 'quarterly budget review' })).toBe("fullText contains 'quarterly budget review'");
  });

  it('a quote and a backslash in the term are escaped (a term can never close the string)', async () => {
    expect(await sentQ({ query: "O'Brien" })).toBe("fullText contains 'O\\'Brien'");
    expect(await sentQ({ query: 'C:\\temp' })).toBe("fullText contains 'C:\\\\temp'");
    expect(await sentQ({ query: "x' or name contains 'y" })).toBe("fullText contains 'x\\' or name contains \\'y'");
  });

  it('a bare term still composes with a folder', async () => {
    expect(await sentQ({ query: 'plan', folder_id: 'F1' })).toBe("fullText contains 'plan' and 'F1' in parents");
  });
});

describe('t163 B — an operator query passes through exactly as written', () => {
  it.each([
    ["name contains 'report'"],
    ["mimeType = 'application/pdf'"],
    ["fullText contains 'budget' and trashed = false"],
    ["modifiedTime > '2026-01-01T00:00:00'"],
    ["'folder-id' in parents"],
    ["name = 'a b' or name = 'c'"],
    ["not name contains 'draft'"],
    ["starred = true"],
    ["properties has { key='k' and value='v' }"],
  ])('%s', async (q) => {
    expect(await sentQ({ query: q })).toBe(q);
  });

  it('no query at all is unchanged (everything not trashed)', async () => {
    expect(await sentQ({})).toBe('trashed = false');
  });

  it('a value that merely CONTAINS an operator word is still a bare term', async () => {
    // "in" and "contains" sit inside the user's words, not between a field and a value.
    expect(await sentQ({ query: 'meeting in Paris contains notes' })).toBe("fullText contains 'meeting in Paris contains notes'");
  });
});

describe('t163 B — the description teaches only syntax Drive accepts', () => {
  const def = googleReadToolDefinitions.find((d) => d.name === 'drive_list')!;
  const queryDescription = String((def.input_schema.properties as Record<string, { description: string }>).query.description);

  /** Drive's `q` grammar, enough of it to judge the examples: `field op value` terms joined by
   *  and/or/not, values single-quoted (or true/false). */
  const FIELD = '(?:name|fullText|mimeType|modifiedTime|createdTime|viewedByMeTime|trashed|starred|sharedWithMe|visibility)';
  const TERM = `(?:not\\s+)?${FIELD}\\s*(?:contains|!=|<=|>=|=|<|>)\\s*(?:'(?:[^'\\\\]|\\\\.)*'|true|false)`;
  const validDriveQuery = (q: string): boolean => new RegExp(`^${TERM}(?:\\s+(?:and|or)\\s+${TERM})*$`).test(q.trim());

  /** The examples are the double-quoted strings in the description. */
  const examples = [...queryDescription.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  it('has examples, and every one parses as Drive syntax (values quoted)', () => {
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const e of examples) expect(validDriveQuery(e), `example ${JSON.stringify(e)}`).toBe(true);
  });

  it('the old, rejected example is gone, and the bare-term behaviour is stated', () => {
    expect(queryDescription).not.toMatch(/name contains report\b/);
    expect(queryDescription).toMatch(/bare word or phrase/i);
  });

  it('the validator itself rejects what Drive rejected (so the clause above can bite)', () => {
    expect(validDriveQuery('name contains report')).toBe(false);
    expect(validDriveQuery("name contains 'report'")).toBe(true);
    expect(validDriveQuery('mimeType = application/pdf')).toBe(false);
  });
});
