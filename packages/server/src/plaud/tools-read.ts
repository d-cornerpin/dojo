// ════════════════════════════════════════
// Plaud Tools (read-only)
// Plaud is a meeting-recording service: device + app capture audio,
// Plaud's cloud transcribes + summarizes. Agents read recordings,
// transcripts, summaries, and AI notes through this tool surface.
// There is no upload/delete API; those happen in the Plaud app/device.
// ════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools/types.js';
import { runPlaudCommand } from './client.js';

export const plaudReadToolDefinitions: ToolDefinition[] = [
  {
    name: 'plaud_list_recordings',
    description: 'List recordings in the connected Plaud account, newest first. Returns each recording\'s id, title, date, duration, and a one-line preview. Use pagination via `page` + `page_size` if there are many recordings. For a targeted lookup by keyword, prefer plaud_search_recordings.',
    effects: [{ kind: 'proc', from: 'derived:npx -y @plaud-ai/cli@latest (network-fetched package, run per call)' }],
    input_schema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number, 1-indexed (default 1).' },
        page_size: { type: 'number', description: 'Recordings per page (default 20, max 100).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'plaud_recent_recordings',
    description: 'List recordings from the last N days. Convenience wrapper around plaud_list_recordings for "what meetings happened this week?" style asks. Default is 7 days.',
    effects: [{ kind: 'proc', from: 'derived:npx -y @plaud-ai/cli@latest (network-fetched package, run per call)' }],
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days back to look (default 7).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'plaud_search_recordings',
    description: 'Search Plaud recordings by keyword across titles and transcript content. Scans the 500 most recent recordings. Use date filters `from` / `to` (ISO date, YYYY-MM-DD) to narrow further.',
    effects: [{ kind: 'proc', from: 'derived:npx -y @plaud-ai/cli@latest (network-fetched package, run per call)' }],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to search for in titles and transcripts.' },
        from: { type: 'string', description: 'Optional earliest date (YYYY-MM-DD).' },
        to: { type: 'string', description: 'Optional latest date (YYYY-MM-DD).' },
        max_results: { type: 'number', description: 'Maximum matches to return (default 20).' },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'plaud_get_recording',
    description: 'Get full metadata for a single Plaud recording by ID. Returns title, date, duration, speakers, file size, and any tags. For the actual content use plaud_get_transcript or plaud_get_summary.',
    effects: [{ kind: 'proc', from: 'derived:npx -y @plaud-ai/cli@latest (network-fetched package, run per call)' }],
    input_schema: {
      type: 'object',
      properties: {
        recording_id: { type: 'string', description: 'Recording ID from plaud_list_recordings or plaud_search_recordings.' },
      },
      required: ['recording_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'plaud_get_transcript',
    description: 'Get the full transcript of a Plaud recording. Returns timestamped lines with speaker labels (when available). Transcripts can be long; consider plaud_get_summary first if you only need the gist.',
    effects: [{ kind: 'proc', from: 'derived:npx -y @plaud-ai/cli@latest (network-fetched package, run per call)' }],
    input_schema: {
      type: 'object',
      properties: {
        recording_id: { type: 'string', description: 'Recording ID.' },
      },
      required: ['recording_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 8000,
  },
  {
    name: 'plaud_get_summary',
    description: 'Get the AI-generated summary for a Plaud recording. The summary is Markdown and typically includes a one-paragraph overview, key topics, and action items (when Plaud detected any). Much shorter than the full transcript - prefer this for "what was the meeting about?" questions.',
    effects: [{ kind: 'proc', from: 'derived:npx -y @plaud-ai/cli@latest (network-fetched package, run per call)' }],
    input_schema: {
      type: 'object',
      properties: {
        recording_id: { type: 'string', description: 'Recording ID.' },
      },
      required: ['recording_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
  {
    name: 'plaud_get_audio_url',
    description: 'Get a temporary signed download URL for the raw audio file of a Plaud recording. URL is valid for 24 hours. Use to attach the audio to an email/Drive upload, share with the user, or pass to another tool that needs the actual audio. The URL is not a Plaud-page link - it points directly at the audio file.',
    effects: [{ kind: 'proc', from: 'derived:npx -y @plaud-ai/cli@latest (network-fetched package, run per call)' }],
    input_schema: {
      type: 'object',
      properties: {
        recording_id: { type: 'string', description: 'Recording ID.' },
      },
      required: ['recording_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 500,
  },
  {
    name: 'plaud_account_info',
    description: 'Get the connected Plaud account\'s email and basic profile info. Useful for the agent to confirm which account it\'s reading from (e.g., when relaying meeting details to the user).',
    effects: [{ kind: 'proc', from: 'derived:npx -y @plaud-ai/cli@latest (network-fetched package, run per call)' }],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 500,
  },
];

// Register concurrency/cap overrides for the v2 partitioner. Mirrors the
// pattern in google/tools-read.ts and microsoft/tools-read.ts.
import { registerConcurrency, registerMaxResultTokens } from '../agent/v2/classifiers/concurrency.js';
for (const def of plaudReadToolDefinitions) {
  if (def.concurrency) registerConcurrency(def.name, def.concurrency);
  if (def.maxResultTokens) registerMaxResultTokens(def.name, def.maxResultTokens);
}

const plaudToolDefByName = new Map(plaudReadToolDefinitions.map(t => [t.name, t]));

// ── Tool Execution ──

export async function executePlaudTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { validateAgainstSchema } = await import('../agent/tool-helpers.js');
  const def = plaudToolDefByName.get(name);
  const schemaErr = validateAgainstSchema(name, def?.input_schema as Parameters<typeof validateAgainstSchema>[1], args);
  if (schemaErr) return schemaErr;

  switch (name) {
    case 'plaud_list_recordings': {
      const page = (args.page as number | undefined) ?? 1;
      const pageSize = Math.min((args.page_size as number | undefined) ?? 20, 100);
      const result = await runPlaudCommand(['files', '--page', String(page), '--page-size', String(pageSize)]);
      if (!result.ok) return result.error ?? 'Plaud files command failed.';
      return formatRecordingList(parsePlaudListOutput(result.stdout));
    }

    case 'plaud_recent_recordings': {
      const days = (args.days as number | undefined) ?? 7;
      const result = await runPlaudCommand(['recent', '--days', String(days)]);
      if (!result.ok) return result.error ?? 'Plaud recent command failed.';
      return formatRecordingList(parsePlaudListOutput(result.stdout));
    }

    case 'plaud_search_recordings': {
      const query = args.query as string;
      const cliArgs = ['search', query];
      if (args.from) cliArgs.push('--from', args.from as string);
      if (args.to) cliArgs.push('--to', args.to as string);
      if (args.max_results !== undefined) cliArgs.push('--max', String(args.max_results));
      const result = await runPlaudCommand(cliArgs);
      if (!result.ok) return result.error ?? 'Plaud search command failed.';
      const parsed = parsePlaudListOutput(result.stdout);
      return formatRecordingList(parsed, `Search results for "${query}":`);
    }

    case 'plaud_get_recording': {
      const recordingId = args.recording_id as string;
      const result = await runPlaudCommand(['file', recordingId]);
      if (!result.ok) return result.error ?? 'Plaud file command failed.';
      // The `file` command outputs human-readable key:value pairs. Pass
      // through with a header so the agent sees it cleanly.
      return `Recording ${recordingId}:\n\n${result.stdout.trim()}`;
    }

    case 'plaud_get_transcript': {
      const recordingId = args.recording_id as string;
      const result = await runPlaudCommand(['transcript', recordingId], { timeoutMs: 60_000 });
      if (!result.ok) return result.error ?? 'Plaud transcript fetch failed.';
      return `Transcript for ${recordingId}:\n\n${result.stdout.trim()}`;
    }

    case 'plaud_get_summary': {
      const recordingId = args.recording_id as string;
      const result = await runPlaudCommand(['summary', recordingId], { timeoutMs: 30_000 });
      if (!result.ok) return result.error ?? 'Plaud summary fetch failed.';
      return `Summary for ${recordingId}:\n\n${result.stdout.trim()}`;
    }

    case 'plaud_get_audio_url': {
      const recordingId = args.recording_id as string;
      const result = await runPlaudCommand(['audio', recordingId]);
      if (!result.ok) return result.error ?? 'Plaud audio URL fetch failed.';
      // CLI prints the signed URL as part of its plain-text output.
      // Some recordings have no audio file uploaded; the CLI emits
      // "Audio not available for this recording" in that case.
      const url = result.stdout.match(/https?:\/\/\S+/)?.[0];
      if (!url) {
        const msg = result.stdout.trim();
        return msg.length > 0
          ? `Plaud returned no URL for recording ${recordingId}: ${msg.slice(0, 300)}`
          : `Plaud returned no URL for recording ${recordingId}.`;
      }
      return `Audio download URL (valid for 24h): ${url}`;
    }

    case 'plaud_account_info': {
      const result = await runPlaudCommand(['me']);
      if (!result.ok) return result.error ?? 'Plaud `me` command failed.';
      // Output is plain text. Try to surface the email cleanly; pass the
      // raw block through so any other fields the CLI prints (plan, name)
      // are visible to the agent.
      const email = result.stdout.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
      const lines = ['Plaud account info:'];
      if (email) lines.push(`Email: ${email}`);
      lines.push('');
      lines.push(result.stdout.trim());
      return lines.join('\n');
    }

    default:
      return `Unknown Plaud tool: ${name}`;
  }
}

// ── Plain-text list parser ──
// Plaud CLI's `files`, `recent`, and `search` commands output a fixed-
// width text table where each row is:
//
//   [optional "N. " index]<32-char hex id>  <title>  <YYYY-MM-DD>  <duration>
//
// Columns are separated by 2+ spaces. Header/footer lines like
// "Matched 50 of 100 scanned" or "Searching for X..." are skipped.

interface ParsedRecording {
  id: string;
  title: string;
  date: string;
  duration: string;
}

function parsePlaudListOutput(text: string): ParsedRecording[] {
  const results: ParsedRecording[] = [];
  // Leading whitespace is the CLI's row indent (2 spaces); the optional
  // "<N>. " is for numbered output some commands use.
  const lineRegex = /^\s*(?:\d+\.\s+)?([a-f0-9]{16,64})\s{2,}(.+?)\s{2,}(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})\s{2,}(\S.*?)\s*$/;
  for (const raw of text.split('\n')) {
    const m = raw.match(lineRegex);
    if (!m) continue;
    const [, id, title, date, duration] = m;
    results.push({ id, title: title.trim(), date, duration: duration.trim() });
  }
  return results;
}

// ── Output formatter ──

function formatRecordingList(records: ParsedRecording[], header?: string): string {
  if (records.length === 0) {
    return header ? `${header}\n(no recordings)` : 'No recordings found.';
  }
  const lines: string[] = [];
  if (header) lines.push(header);
  for (const r of records) {
    lines.push(`- "${r.title}" | ${r.date} | ${r.duration}\n    ID: ${r.id}`);
  }
  lines.push('');
  lines.push(`${records.length} recording(s). Use plaud_get_transcript(recording_id) or plaud_get_summary(recording_id) for content.`);
  return lines.join('\n');
}
