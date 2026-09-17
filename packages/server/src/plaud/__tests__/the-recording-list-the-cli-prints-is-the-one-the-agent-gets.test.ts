// ════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T75b — THE RECORDING LIST THE CLI PRINTS IS THE ONE THE AGENT GETS
//
// OWNER REPORT (dev box, 2026-09-16): `plaud_recent_recordings` answers
// "No recordings found." while the same account, the same minute, from a shell,
// lists 23 recordings.
//
// ROOT CAUSE. Not auth, not env, not the spawn. Instrumentation on
// `runPlaudCommand` showed the server's child process receiving exit 0 and the
// full 23-row table — byte-identical to the shell run. The list was thrown away
// one function later: `parsePlaudListOutput` required each row to OPEN with
// 16-64 hex characters, and every id the CLI prints is `of_` + 32 hex. Not one
// row matched, the parse returned `[]`, and `formatRecordingList` turned the
// empty array into a confident sentence. All three list tools — `recent`,
// `files`, `search` — went through that same regex, so the whole read surface
// of the integration reported an empty account.
//
// WHAT THESE CLAUSES HOLD:
//   • the id column is parsed as the CLI actually prints it: an optional short
//     type prefix (`of_`) in front of the hex.
//   • the `files` table's header and rule lines are still not recordings.
//   • AN EMPTY PARSE NEVER AGAIN BECOMES "No recordings found." When no row
//     parses, the agent gets THE CLI'S OWN WORDS. A genuinely empty account
//     then reads as the CLI's "No recordings matched ..."; a format the parser
//     has not learned yet reads as the table itself — visible, not invented.
//     That last clause is the one that cost a day: the tool did not fail, it
//     lied, and nothing upstream could tell the two apart.
//
// The fixtures below are verbatim stdout from `@plaud-ai/cli@latest` captured
// on 2026-09-16, ids included.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── The CLI, faked at the process boundary ──
let cliStdout = '';
vi.mock('node:child_process', () => {
  const execFile = (): void => undefined;
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: cliStdout, stderr: '' });
  return { execFile, spawn: () => ({ on: () => undefined, stdout: null, stderr: null, kill: () => undefined }) };
});

const { executePlaudTool } = await import('../tools-read.js');

// Verbatim `recent --days 3` stdout (first rows).
const RECENT_STDOUT = [
  '',
  'Recordings in the last 3 days: 23',
  '',
  '  of_38cd455de5582b16fbded77bda37572a  09-16 Meeting: Freemium Campaign Legal Alignment, Google App Timeline, Copy CTA Update  2026-09-16  20m36s',
  '  of_5759a583de970e253df5b71c72059d4f  09-16 Meeting: Project Delays, Co-work Complexity, Excel Asset Decision, and OOH Strategy  2026-09-16  11m25s',
  '  of_7dff23b5aeac461f4319fc69fe8b5eba  2026-09-14 16:11:22  2026-09-14  8s',
  '',
].join('\n');

// Verbatim `files --page 1 --page-size 10` stdout: a header row and a rule
// line sit above the records, and titles are ellipsised to the column width.
const FILES_STDOUT = [
  '',
  'Files on this page: 10',
  '',
  '  ID                                  NAME                                  DATE          DURATION',
  '  ──────────────────────────────────────────────────────────────────────────────────────────────────',
  '  of_38cd455de5582b16fbded77bda37572a  09-16 Meeting: Freemium Campaign Le…  2026-09-16    20m36s',
  '  of_5295e0ce2ca73065d7e918f891a0d53d  09-15 Meeting: Video Edit Review, V…  2026-09-15    32m54s',
  '',
].join('\n');

// Verbatim `search` stdout when nothing matches — the CLI's own empty.
const EMPTY_SEARCH_STDOUT = [
  'No recordings matched "zzzqqqxyzzyplaudnope" in 500 scanned.',
  '(Scanned first 500; narrow the window with --from/--to if your target is older.)',
  '',
].join('\n');

describe('the recording list the CLI prints is the one the agent gets', () => {
  beforeEach(() => { cliStdout = ''; });

  it('reads recordings whose ids carry the CLI\'s type prefix', async () => {
    cliStdout = RECENT_STDOUT;
    const out = await executePlaudTool('plaud_recent_recordings', { days: 3 });

    expect(out).not.toContain('No recordings found.');
    expect(out).toContain('of_38cd455de5582b16fbded77bda37572a');
    expect(out).toContain('of_5759a583de970e253df5b71c72059d4f');
    expect(out).toContain('of_7dff23b5aeac461f4319fc69fe8b5eba');
    expect(out).toContain('3 recording(s).');
  });

  it('reads the `files` table without mistaking its header or rule for a recording', async () => {
    cliStdout = FILES_STDOUT;
    const out = await executePlaudTool('plaud_list_recordings', { page: 1, page_size: 10 });

    expect(out).toContain('of_38cd455de5582b16fbded77bda37572a');
    expect(out).toContain('of_5295e0ce2ca73065d7e918f891a0d53d');
    expect(out).toContain('2 recording(s).');
    expect(out).not.toContain('NAME');
    expect(out).not.toContain('───');
  });

  it('reads search results the same way', async () => {
    cliStdout = RECENT_STDOUT;
    const out = await executePlaudTool('plaud_search_recordings', { query: 'meeting' });

    expect(out).toContain('of_38cd455de5582b16fbded77bda37572a');
    expect(out).not.toContain('(no recordings)');
  });

  // ── The clause that cost the day ──
  it('hands back the CLI\'s own words when no row parses, instead of inventing an empty list', async () => {
    cliStdout = EMPTY_SEARCH_STDOUT;
    const empty = await executePlaudTool('plaud_search_recordings', { query: 'zzzqqqxyzzyplaudnope' });
    expect(empty).toContain('No recordings matched "zzzqqqxyzzyplaudnope" in 500 scanned.');

    // A table shape the parser has not learned yet must be VISIBLE, not silently
    // flattened into "no recordings". This is exactly what `of_` prefixes did.
    cliStdout = 'Recordings: 2\n\n  zz9_deadbeefdeadbeefdeadbeef | Some Meeting | 2026-09-16 | 5m\n';
    const unknown = await executePlaudTool('plaud_recent_recordings', { days: 3 });
    expect(unknown).not.toBe('No recordings found.');
    expect(unknown).toContain('Some Meeting');
  });

  it('still says nothing was found when the CLI itself prints nothing', async () => {
    cliStdout = '   \n\n';
    const out = await executePlaudTool('plaud_recent_recordings', { days: 3 });
    expect(out).toBe('No recordings found.');
  });
});
