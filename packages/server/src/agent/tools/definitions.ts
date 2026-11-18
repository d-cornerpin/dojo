// ════════════════════════════════════════════════════════════════════════════
// `toolDefinitions` IS the wire payload: `agent/model.ts` projects {name,
// description, input_schema} out of it onto the provider request, and BOTH
// prompt goldens hash exactly that projection. ORDER IS THE CACHE BREAKPOINT:
// the prefix cache sits on the last always-loaded tool, so re-ordering this
// array silently multiplies token cost without failing any behavioural test.
// `getAllToolDefinitions()` below is the one declared emission order and
// `registry.ts` preserves it. The register loop at the bottom is a projection
// OF the array and travels with it at module load, so the registry cannot
// silently stop covering a tool somebody adds here.
// ════════════════════════════════════════════════════════════════════════════

import type { ToolDefinition } from './types.js';
import { workProp, WORK_PRIORITY_ENUM, WORK_FIELD_TEXT, WORK_MEASURE_PROP, WORK_MEASURE_REF_PROP } from '../work-verb-schema.js';
import { WORK_PLAN_PROP } from '../work-plan-schema.js';
import { PER_TOOL_VALIDATED_AT_BOUNDARY } from './validate-args.js';
import { pdfToolDefinitions } from '../pdf-tools.js';
import { formsToolDefinitions } from '../../google/tools-forms.js';
import { credentialsToolDefinitions } from '../../credentials/tools.js';
import { plaudReadToolDefinitions } from '../../plaud/tools-read.js';
import { googleReadToolDefinitions } from '../../google/tools-read.js';
import { googleWriteToolDefinitions } from '../../google/tools-write.js';
import { slidesToolDefinitions } from '../../google/tools-slides.js';
import { microsoftReadToolDefinitions } from '../../microsoft/tools-read.js';
import { microsoftWriteToolDefinitions } from '../../microsoft/tools-write.js';
import { officeCreateToolDefinitions, officeWordEditToolDefinitions, officeExcelEditToolDefinitions, officeEditToolDefinitions } from '../../microsoft/tools-office.js';
import { unifiedToolDefinitions } from '../../tools/unified-read.js';
import { dojoInspectDefinition } from '../../inspect/definition.js';   // the eight inspect views, one schema
import { V2_MAX_TOOL_RESULT_TOKENS } from '../../memory/tool-result-view.js';


/**
 * Every tool definition the platform can expose, across all families. Single
 * source of truth for the doc generator: add a new family HERE, never to a
 * side list, so "described" and "loadable via load_tool_docs" cannot drift.
 */
export function getAllToolDefinitions(): ToolDefinition[] {
  return [
    ...toolDefinitions,
    ...pdfToolDefinitions,
    ...formsToolDefinitions,
    ...credentialsToolDefinitions,
    ...plaudReadToolDefinitions,
    ...googleReadToolDefinitions,
    ...googleWriteToolDefinitions,
    ...slidesToolDefinitions,
    ...microsoftReadToolDefinitions,
    ...microsoftWriteToolDefinitions,
    ...officeCreateToolDefinitions,
    ...officeWordEditToolDefinitions,
    ...officeExcelEditToolDefinitions,
    ...officeEditToolDefinitions,
    ...unifiedToolDefinitions,
  ];
}

// Two lookups, both memoized because `executeToolInner` asks on every call.

let toolDefsByName: Map<string, ToolDefinition> | null = null;

/** Every definition by name, including the `user_` twins. Memoized: the
 *  validation boundary asks on every tool call. */
export function toolDefinitionsByName(): ReadonlyMap<string, ToolDefinition> {
  if (!toolDefsByName) {
    toolDefsByName = new Map(getAllToolDefinitions().map((d) => [d.name, d] as const));
  }
  return toolDefsByName;
}

let boundaryValidatedNames: Set<string> | null = null;

/**
 * True when this tool's `input_schema.required` is enforced at the one
 * validation boundary: the per-tool validated set, plus every tool of the
 * provider modules, read off the definition arrays themselves so a new one is
 * covered the moment it is declared. False for the six work verbs (requiredness
 * is per-operation there) and for tools that never had a required-field check:
 * adding one would be a new refusal, which is owner-reserved. Exported for the
 * conformance test.
 */
export function isBoundaryValidated(name: string): boolean {
  if (!boundaryValidatedNames) {
    boundaryValidatedNames = new Set<string>(PER_TOOL_VALIDATED_AT_BOUNDARY);
    for (const defs of [
      formsToolDefinitions,
      plaudReadToolDefinitions,
      googleReadToolDefinitions,
      googleWriteToolDefinitions,
      slidesToolDefinitions,
      microsoftReadToolDefinitions,
      microsoftWriteToolDefinitions,
      officeCreateToolDefinitions,
      officeWordEditToolDefinitions,
      officeExcelEditToolDefinitions,
      officeEditToolDefinitions,
    ]) {
      for (const d of defs) boundaryValidatedNames.add(d.name);
    }
  }
  return boundaryValidatedNames.has(name);
}

// ── Tool Schemas for Anthropic API ──

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'approve_destructive_action',
    description: 'Decide a destructive-action approval request (primary agent only). The engine holds non-primary agents\' destructive tool calls (file deletion, destructive shell commands) and sends you a request with a token. Approve only when the action clearly serves the assigned work; use your judgment about checking with the owner first. Approval is one-shot and expires in 60 minutes.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'The approval token from the request message' },
        decision: { type: 'string', enum: ['approve', 'deny'], description: 'approve or deny' },
      },
      required: ['token', 'decision'],
    },
  },
  {
    name: 'load_tool_docs',
    concurrency: 'safe',
    description: 'Load the full documentation for one or more tools before using them. Call this when you need to review a tool\'s parameters or usage details. After loading, the tools become callable on subsequent turns. Your always-loaded tools are already available without needing this.',
    // The docs are markdown files written to disk at boot. The directory is the
    // whole reach: the handler intersects names with the agent's accessible tools.
    effects: [
      { kind: 'fs_read', from: 'derived:the generated tool documentation directory', scope: { at: 'tree', template: '~/.dojo/tools' } },
    ],
    input_schema: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tool names to load documentation for (e.g., ["gmail_send", "calendar_create"])',
        },
      },
      required: ['tools'],
    },
  },
  {
    name: 'exec',
    description: 'Run ONE program directly and return its output, with NO shell. `argv` is an array: the first element is the program, every other element is one literal argument. Because there is no shell, characters like | > < * $ ` && ; are ordinary text — they do NOT pipe, redirect, glob or substitute. Use the `shell` tool when you need any of those. **Before reaching for exec, scan the tool index for a purpose-built tool**, there are dedicated tools for reading files (file_read), writing files (file_write), patching files (file_patch), web fetch (web_fetch), calendar, drive, forms, office docs, tracker, vault, scheduling, sending messages, and more. Use exec only when no purpose-built tool fits. If the task is "look at the chat / recall what was said," call recall_recent_thread instead of digging through files. Example: exec({ argv: ["ls", "-la", "~/projects"] }). Returns stdout and stderr.',
    effects: [{ kind: 'proc', from: 'args.argv' }],
    input_schema: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'The program and its arguments, one per element. E.g. ["git","status","--short"]. NOT a shell command line — do not put a whole command in one string, and do not use pipes or redirection here.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute directory to run in (optional; defaults to the agent workspace).',
        },
        timeout: {
          type: 'number',
          description: 'Milliseconds of SILENCE to tolerate before the command is stopped. Optional: without it the command may stay quiet for as long as your silent window (two hours unless the owner set yours longer). This bounds the gap between writes to stdout/stderr, NOT total runtime; a command that keeps producing output is never killed for taking long. Pass a short value only when you know the command should answer fast.',
        },
      },
      required: ['argv'],
    },
    concurrency: 'serial',
  },
  {
    name: 'shell',
    description: 'Run a shell SCRIPT under /bin/zsh and return its output — this is the tool for pipes, redirection, globbing, variables, command substitution, `&&`/`;` chains and for/while/if loops. Requires shell access; if you only need to run one program with plain arguments, use exec({argv:[...]}) instead, which is safer and always available to you if exec is. The whole script text is recorded. Example: shell({ script: "ls -la ~/projects | grep report | wc -l" }). Returns stdout and stderr.',
    effects: [{ kind: 'shell', from: 'args.script' }],
    input_schema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'The shell script to run under /bin/zsh. May contain pipes, redirects, loops and substitution.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute directory to run in (optional; defaults to the agent workspace).',
        },
        timeout: {
          type: 'number',
          description: 'Milliseconds of SILENCE to tolerate before the command is stopped. Optional: without it the command may stay quiet for as long as your silent window (two hours unless the owner set yours longer). This bounds the gap between writes to stdout/stderr, NOT total runtime; a command that keeps producing output is never killed for taking long. Pass a short value only when you know the command should answer fast.',
        },
      },
      required: ['script'],
    },
    concurrency: 'serial',
  },
  {
    name: 'tool_result_read',
    description: 'Read part of an earlier tool result too long to show whole (its note names the id). One page per call; the page says how to read on.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id in the note.' },
        from_line: { type: 'number', description: 'First line (from 1).' },
        to_line: { type: 'number', description: 'Last line.' },
        offset: { type: 'number', description: 'Character offset, for a very long line.' },
        search: { type: 'string', description: 'Text to find; lists matching lines with their numbers.' },
      },
      required: ['id'],
    },
    concurrency: 'safe',
  },
  {
    name: 'continue_repeating',
    description: 'Run again a call the engine stopped because it kept bringing back the same result. Give a one-line reason why repeating it is still useful.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why running the stopped call again is useful, in one line.' } },
      required: ['reason'],
    },
    concurrency: 'serial',
  },
  {
    name: 'file_read',
    description: `Read the contents of a file at the given absolute path. For text files, returns line-numbered content. Use optional offset (line number, 0-indexed) and limit (line count, default 5000) to read a long file page by page. One call returns at most ~${Math.round(V2_MAX_TOOL_RESULT_TOKENS / 1000)}K tokens (about ${Math.round(V2_MAX_TOOL_RESULT_TOKENS * 4 / 2000)} pages of text); a longer file comes back as a page that ends with a "continue at offset N" line, so keep reading from that offset until the end-of-file line shows. For images (PNG, JPEG, GIF, WEBP) and PDFs, returns content for vision (paging not applicable). Example: file_read({ path: "/Users/me/foo.html" }).`,
    effects: [{ kind: 'fs_read', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (0-indexed). Default 0. Only needed when paginating a file larger than the per-call cap.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to return. Default 5000. A page also stops at the per-call size cap, so long lines may give fewer; the closing line says where to continue.',
        },
      },
      required: ['path'],
    },
    concurrency: 'safe',
    // The cap is the model's own per-result view (`memory/tool-result-view.ts`);
    // the handler sizes each page to it.
    maxResultTokens: V2_MAX_TOOL_RESULT_TOKENS,
  },
  {
    name: 'file_write',
    description: 'Write content to a file at the given absolute path. Creates parent directories if they do not exist. Overwrites existing files. For long content, write the first part here and add each next part with file_append. Returns a download URL that works from anywhere (including remote access). Share the download URL with the user so they can access the file from any device. Example: file_write({ path: "/Users/me/output.txt", content: "Hello world" }).',
    effects: [{ kind: 'fs_write', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
    // Writing an EMPTY file is a real thing agents do (truncating a log, laying
    // down a placeholder). Required, but "" is a legitimate value.
    fields: { content: { allowEmpty: true } },
  },
  {
    name: 'file_append',
    description: 'Append content to the end of a file at the given absolute path. Creates the file (and parent directories) if they do not exist. Use this for incremental writes, accumulating output across multiple turns, building a long doc one section at a time, logging progress to a scratchpad, instead of `file_write` (which overwrites everything) or the read-modify-rewrite cycle. The latter fills your context with the file\'s existing contents every time you want to add to it; `file_append` does not. Returns bytes appended, total file size, and a download URL.\n\nExample: file_append({ path: "/Users/me/notes.md", content: "\\n## Section 5\\nNew content here." }).\n\nBy default a leading newline is added if the existing file doesn\'t already end in one (so appended sections don\'t smush into the prior line). Set ensure_newline=false to append the exact bytes verbatim.',
    // The last-byte peek before appending goes through the write handle, so the call only writes.
    effects: [{ kind: 'fs_write', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file. Created if it does not exist.' },
        content: { type: 'string', description: 'Content to append.' },
        ensure_newline: { type: 'boolean', description: 'When true (default), prepend a newline to `content` if the existing file does not already end with one. Avoids accidentally concatenating two sections into one line.' },
      },
      required: ['path', 'content'],
    },
    // Same as file_write: an empty append is a no-op the caller may legitimately
    // ask for, and refusing it would be a new refusal.
    fields: { content: { allowEmpty: true } },
  },
  {
    name: 'file_patch',
    description: 'Surgically edit an existing file in place by find-and-replace, without rewriting the whole thing. Use this when you want to change a specific section of a file you have ALREADY read, the agent equivalent of opening a file, ctrl-F replacing a few strings, and saving. Strongly preferred over file_write for edits, because file_write requires you to reconstruct the entire file from memory and routinely drops content the model didn\'t explicitly type back.\n\nEach patch is `{ search, replace, replace_all? }`. The tool reads the file, applies every patch in order against the in-memory copy, and only writes to disk if every search string matched. If any patch\'s search string is not found, the call FAILS with a hard error and the file on disk is not touched, there is no silent no-op. Patches apply sequentially, so a later patch sees the result of earlier patches.\n\nExamples:\n  • Rename a heading: file_patch({ path: "/Users/me/site.html", patches: [{ search: "<h1>Old Title</h1>", replace: "<h1>New Title</h1>" }] })\n  • Replace every occurrence: file_patch({ path: "/Users/me/style.css", patches: [{ search: "color: red", replace: "color: var(--brand)", replace_all: true }] })\n  • Multiple edits at once: file_patch({ path: "...", patches: [{ search: "...", replace: "..." }, { search: "...", replace: "..." }] })\n  • Preview without writing: pass dry_run=true to see what would change without touching disk.\n\nWorks on any text file (encoding stays as-is on disk; the in-memory edit is utf-8). Refuses files that look binary. Refuses empty search strings.',
    effects: [{ kind: 'fs_read', from: 'args.path' }, { kind: 'fs_write', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to edit. Must already exist.',
        },
        patches: {
          type: 'array',
          description: 'Ordered list of find/replace operations. Each is applied against the current in-memory state of the file, so a later patch can match content produced by an earlier one. If any patch\'s search string is not found, the whole call fails and nothing is written.',
          items: {
            type: 'object',
            properties: {
              search: {
                type: 'string',
                description: 'Exact string to find. Whitespace and line endings count. Empty strings rejected.',
              },
              replace: {
                type: 'string',
                description: 'String to substitute in. Use empty string to delete the matched span.',
              },
              replace_all: {
                type: 'boolean',
                description: 'When true, replace every occurrence of search; default false (replace only the first).',
              },
            },
            required: ['search', 'replace'],
          },
        },
        dry_run: {
          type: 'boolean',
          description: 'When true, validate the patches and report what would change without writing to disk. Default false.',
        },
      },
      required: ['path', 'patches'],
    },
    fields: {
      patches: {
        requiredNotEnforced:
          'the handler rejects a missing/empty patches list with a SHAPE message the generic one would lose ' +
          '("patches must be a non-empty array of { search, replace } objects.") — see the file_patch case in executeToolInner',
      },
    },
    maxResultTokens: 2000,
  },
  {
    name: 'scratchpad_set',
    description: '**Use this INSIDE a tracker step, not instead of one.** Scratchpad is your in-flight working memory for the CURRENT iteration of work, which sources you\'ve read so far, what\'s left, decisions you\'ve made on this step. The engine re-injects it at the top of your context regardless of compaction, so it survives within a session.\n\n**Critical distinction**: scratchpad survives compaction but does NOT survive session reset, and is invisible to the user and PM. Only the tracker survives reset and is visible. **If you\'re using scratchpad without an open tracker project for non-trivial work, you\'ve made the wrong call**, the work will silently vanish on the next reset with no way to resume. For any work involving a deliverable, multiple steps, or more than ~3 tool calls, open `work_open(kind="project")` FIRST, then use scratchpad for the in-flight thinking inside each step.\n\nThe scratchpad is a single string; calling `scratchpad_set` REPLACES the current contents (it does not append). To make a small edit, copy the current scratchpad from the YOUR SCRATCHPAD block in your context, modify, and call this with the full new text. Cap is 8000 characters, if you\'re approaching that, move detail into a real file and keep the scratchpad as a high-level index. Clears automatically on session reset. Use `scratchpad_clear` to empty it mid-session.\n\nExample (in-flight research on step 2 of a tracker project):\n  scratchpad_set({ content: "## Current tracker step: Step 2, Cover sources A-D\\n\\n## Sources covered so far\\n- [x] /Users/me/notes/a.md (covered in §1)\\n- [x] /Users/me/notes/b.md (covered in §2)\\n- [ ] /Users/me/notes/c.md\\n- [ ] /Users/me/notes/d.md\\n\\n## Open questions\\n- Does Y depend on Z or vice-versa? (check c.md)" }).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full new scratchpad content. Replaces previous. Max 8000 chars.' },
      },
      required: ['content'],
    },
    // Setting the pad to "" is how an agent empties it without scratchpad_clear.
    fields: { content: { allowEmpty: true } },
  },
  {
    name: 'scratchpad_clear',
    description: 'Empty your scratchpad. Use when the task it was tracking is complete and the outline is no longer relevant. Scratchpad also auto-clears on session reset, so manual clear is mostly for "I finished, but the session keeps going" cases.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'file_list',
    concurrency: 'safe',
    description: 'List the contents of a directory at the given absolute path. Returns file names, sizes, and types. Example: file_list({ path: "~/projects" }).',
    // Stats every entry IN the directory, so the tree is the effect; without it per-entry refusals
    // show as `-`. `file_read`'s identical `from` deliberately carries no tree.
    effects: [{ kind: 'fs_read', from: 'args.path', scope: { at: 'argTree' } }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory to list',
        },
      },
      required: ['path'],
    },
    scale: { note: 'one call lists every entry of a directory, with sizes' },
  },
  {
    name: 'share_file',
    concurrency: 'safe',
    description: 'Get a download URL for an existing file so the user can access it from any device. Use this when the user asks for a link to a file, wants to download something, or you need to share a file that already exists on disk. Returns a full clickable URL. IMPORTANT: Give the user the URL exactly ONCE as plain text. Do NOT repeat it, do NOT wrap it in markdown, do NOT add extra formatting.',
    effects: [{ kind: 'fs_read', from: 'args.path' }],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to share (use ~ for home directory)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'recall_recent_thread',
    description: '**Call this when you genuinely feel disoriented and the active context is not enough.** Common triggers: you just saw a `── Memory Compacted ──` divider and you\'re mid-task with no clear sense of what was just done; you switched models and lost reasoning state; you\'re about to start something and want to confirm what the user actually asked for; you suspect you might double-process work that was already done.\n\n**v2.7.10 note (IMPORTANT):** the engine no longer auto-runs this for you after compaction. Earlier versions secretly executed recall + injected the result as a system message on your next significant tool call; that caused context spirals (each compaction → auto-recall → bigger fresh tail → faster next compaction → bigger re-injection → ...). Now compaction is silent except for the divider, and YOU decide whether to call this. If you are confidently executing a scheduled task or a clear next step, DON\'T call it, your tracker tasks, equipped techniques, and active directives already carry the state you need. Calling unnecessarily wastes tokens and re-introduces stale content.\n\nReturns a clean transcript of the recent conversation read directly from your messages table (same data shown on the dashboard chat), regardless of what the assembler put in your active context. By default the last 8 user→assistant exchanges with tool *call* lines (file_read path=…, exec command=…). To recover **actual content** the agent saw earlier (file contents, web fetch bodies, search results), set `include_tool_results: true`, that switches on "wordy mode" which includes tool RESULTS up to a per-result char cap (default 1500). User/assistant message text is also capped per message (default 1500 chars, raise via `truncate_message_chars` up to 8000), anything truncated ends with a history_get pointer so you can fetch the full body. For longer lookback, paginate with `before_id` (the response footer tells you which id to pass). Cheap, read-only, safe to call anytime.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        turn_count: {
          type: 'number',
          description: 'How many of the most recent user→assistant exchanges to include. Default 8, max 30.',
        },
        include_tool_calls: {
          type: 'boolean',
          description: 'When true, include a one-line summary of each tool CALL ("[called: file_read path=…]"). Note: this only shows the call args, not the result. For tool RESULTS, set include_tool_results=true. Default true.',
        },
        include_tool_results: {
          type: 'boolean',
          description: '"Wordy mode", include tool RESULTS (file contents, web fetch bodies, exec stdout, etc.) up to truncate_tool_result_chars per result. Use this when you need to recover specific content the agent saw earlier. Default false (results omitted to keep transcript tight).',
        },
        truncate_tool_result_chars: {
          type: 'number',
          description: 'Per-tool-result character cap when include_tool_results=true. Default 1500, max 4000. Each truncated result ends with a history_get pointer for the full body.',
        },
        truncate_message_chars: {
          type: 'number',
          description: 'Per-message character cap for user/assistant text. Default 1500, max 8000. Each truncated message ends with a history_get pointer for the full body. Raise this when you need to read longer messages in full instead of paginating through history_get.',
        },
        before_id: {
          type: 'string',
          description: 'Pagination cursor, return turns OLDER than the message with this id. The response footer tells you which id to pass for the next slice. Omit on the first call to get the most recent turns.',
        },
        since: {
          type: 'string',
          description: 'Optional ISO timestamp, only include messages on or after this time. Useful for "show me everything since 2pm today" style lookbacks.',
        },
        scope: {
          type: 'string',
          enum: ['conversation', 'all'],
          description: 'Default "conversation", recall is limited to the conversation you are currently in (the person/thread this turn is about), so an unrelated task\'s output does not bleed in. Pass "all" only when you genuinely need to look across every recent conversation (e.g. "what have I been doing across everything?").',
        },
      },
      required: [],
    },
    maxResultTokens: 4000,
  },
  {
    name: 'history_search',
    description: 'Search through conversation history and memory summaries using full-text search or pattern matching. Returns matching messages and summaries with context. Example: history_search({ pattern: "budget meeting", limit: 10 }).\n\nResult format: each line starts with `[id=<short> <timestamp>] (role) <snippet>`. When a snippet is truncated, the line ends with `[snippet only, call history_get(id="…") for full N-char message]`, DO this rather than retrying history_search with a different pattern. Use history_get to get the FULL message body once you have a hit.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The search string. Canonical, preferred arg.',
        },
        // `query` is a declared alias for `pattern`: the executor honors
        // `args.pattern ?? args.query`, so it is not a stray arg to warn about.
        query: {
          type: 'string',
          description: 'Alias for `pattern` (accepted for convenience; prefer `pattern`). Pass exactly one of the two.',
        },
        mode: {
          type: 'string',
          enum: ['full_text', 'regex'],
          description: 'Search mode: full_text (FTS5) or regex (LIKE fallback). Default: full_text',
        },
        scope: {
          type: 'string',
          enum: ['messages', 'summaries', 'both'],
          description: 'What to search: messages, summaries, or both. Default: both',
        },
        since: {
          type: 'string',
          description: 'Only search messages after this ISO timestamp',
        },
        before: {
          type: 'string',
          description: 'Only search messages before this ISO timestamp',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 20)',
        },
      },
      // Not ['pattern']: the executor accepts pattern or query and enforces
      // "at least one non-empty" itself, so the schema must not contradict it.
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
  {
    name: 'history_get',
    concurrency: 'safe',
    description: 'Look up the full content of a stored item by its ID. Accepts THREE id types:\n  - Summary IDs (sum_*), returns full summary text + metadata\n  - Large file IDs (file_*), returns the exploration summary + metadata\n  - Raw message UUIDs, returns the full message body\n\nUse this AFTER history_search when a snippet is truncated and you need the full message. history_search emits a ready-to-copy hint at the end of each truncated result line: `[snippet only, call history_get(id="…") for full N-char message]`. Copy the full UUID from inside those quotes, the short `id=<8chars>` shown at the start of the result line is for visual scanning only and is NOT enough.',
    // `file_*` ids are served by reading the stored body off disk, so the read
    // is declared; the per-agent ownership check still runs after the read.
    effects: [
      { kind: 'fs_read', from: 'derived:the large-file store a file_* row points into', scope: { at: 'tree', template: '~/.dojo/data/files' } },
    ],
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'A summary ID (sum_*), large file ID (file_*), or full message UUID (from the parens in history_search\'s expand hint).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'history_expand',
    concurrency: 'safe',
    description: 'Deep recall: walks the summary DAG to retrieve original source messages, optionally uses an LLM to synthesize an answer from expanded material. Use when summaries lack detail.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional search query to find relevant summaries to expand',
        },
        summary_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of specific summary IDs to expand',
        },
        prompt: {
          type: 'string',
          description: 'The question or instruction for the expansion, what you want to recall or understand',
        },
      },
      required: ['prompt'],
    },
  },
  // ── Web Tools ──
  {
    name: 'web_search',
    description: 'Search the web using Brave Search. Returns up to 10 results with titles, URLs, and snippets. Requires a Brave Search API key to be configured.',
    effects: [{ kind: 'net', from: 'fixed:api.search.brave.com' }],
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (default: 5, max: 20)',
        },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a URL and extract focused content matching your prompt. The tool fetches the page and uses a fast model to return ONLY what you asked for (~1-2K tokens), not the raw page (which can be 50K+). The `prompt` is REQUIRED, be specific. Requires network_domains permission.\n\nExamples:\n  web_fetch({ url: "https://...", prompt: "the main argument and 3 supporting points" })\n  web_fetch({ url: "https://...", prompt: "all pricing tiers and their dollar amounts" })\n  web_fetch({ url: "https://...", prompt: "the API endpoint table" })',
    effects: [{ kind: 'net', from: 'args.url' }],
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
        prompt: {
          type: 'string',
          description:
            'What to extract from the page. REQUIRED, be specific. The more focused the prompt, the more useful the extract.',
        },
      },
      required: ['url', 'prompt'],
    },
    fields: {
      prompt: {
        requiredNotEnforced:
          'the handler refuses a missing prompt with the message that TEACHES the parameter (an example call plus the ' +
          'reason — a prompt keeps the result ~1-2K tokens instead of dumping a 50K page); the generic message would drop it',
      },
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  // ── Right Dock (shared workspace) ──
  {
    name: 'canvas_render',
    description:
      'Open a canvas in the user\'s right dock, a side panel where you and the user look at a working document together. The dojo interface slides left to make room and the canvas renders on the right. Use this to show the user something you have produced or have on disk: an HTML page, a Markdown doc, a plain-text/code file, a report, a chart, a mockup, or a Word / Excel / PDF document (these render as a formatted preview).\n\nNOTE: any canvas-renderable file already opens in the canvas automatically the moment you create it, writing one with file_write (HTML, Markdown, text, code, JSON, CSV, SVG, ...) and creating a Word / Excel / PDF document all auto-open. You usually do NOT need to call canvas_render at all. Use canvas_render to (re)show an existing file, or to render inline `html` / a `url`.\n\nThree ways to fill it (use ONE):\n  • `path`, the absolute path to a file on disk you wrote with file_write (e.g. "/Users/.../uploads/<agent-id>/report.md"). BEST for documents you will keep editing: HTML renders, Markdown renders formatted, text/code shows monospaced, and the canvas gets a download button. After you call canvas_render({path}), any later file_write / file_patch / file_append to that SAME path auto-refreshes the canvas, you do NOT need to call canvas_render again. For HTML, relative asset paths resolve against the file\'s own folder, so reference local images as <img src="photo.png"> with the image saved next to the .html file and it will render.\n  • `html`, inline HTML markup to render directly (runs sandboxed); no file needed. Inline markup cannot reference local files, embed images as data: URIs or write a file with the image beside it instead.\n  • `url`, content already hosted at a URL (a file_write download URL also works).\n\nExamples:\n  • canvas_render({ title: "Spec", path: "/Users/me/uploads/<agent-id>/spec.md" })\n  • canvas_render({ title: "Q3", html: "<h1>Q3</h1><p>...</p>" })',
    effects: [{ kind: 'fs_read', from: 'args.path' }, { kind: 'net', from: 'args.url' }],
    // `src` is an HTML attribute in the worked example (`<img src="photo.png">`),
    // not a parameter of this tool.
    advertisedNotDeclared: {
      src: 'an HTML attribute in the inline example markup, not a parameter of this tool',
    },
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to a file on disk to show (html, markdown, text, code, image, or pdf). Preferred for documents you will keep editing, edits to this path auto-refresh the canvas. Provide ONE of path / html / url.',
        },
        html: {
          type: 'string',
          description: 'Inline HTML markup to render in the canvas. A full document or a fragment. Runs sandboxed (scripts allowed). Provide ONE of path / html / url.',
        },
        url: {
          type: 'string',
          description: 'A URL to load in the canvas (for example a file_write download URL). Provide ONE of path / html / url.',
        },
        title: {
          type: 'string',
          description: 'Optional short label shown in the canvas header.',
        },
      },
      required: [],
    },
    concurrency: 'safe',
  },
  {
    name: 'screen_broadcast',
    description:
      "Show the user THIS Mac's screen, live, in their right-dock canvas. Use this whenever the user wants to SEE your screen or control this Mac, phrasings like \"show me your screen\", \"let me see your screen\", \"share your screen\", \"can I see what you're doing\", \"open your screen so I can click something\".\n\nUse it proactively whenever you need a HUMAN to do something on THIS Mac that you can't do yourself: approve a macOS permission/confirmation dialog, hit OK on a prompt, or complete a sign-in / re-authenticate an account (e.g. a Google or Microsoft re-auth, which opens a login window in the browser on this Mac). The flow is: kick off the action that needs them (so the dialog or sign-in window appears on this Mac), then open the screen with this tool so they can take control and finish it. Judge local vs remote first: if the user is sitting AT this Mac, just ask them to do it on their screen directly, no need to share. If they're remote (over the tunnel) and can't reach the Mac, that's exactly when to open the screen. (One caveat to relay if it comes up: a few highly-secured macOS dialogs, like granting Accessibility/Screen Recording permissions, may refuse remote clicks and need someone physically at the Mac.)\n\nIt opens view-only. The user clicks \"Take control\" at the top of the canvas to use the mouse and keyboard, and enters the screen-sharing (VNC) password to connect, that's their second factor, on top of being logged in.\n\nThis only works if the user has turned the feature on in Settings → Integrations → Screen Sharing (it's disabled by default; one-time setup needs approval on the Mac). If it's off, calling this returns step-by-step setup instructions, relay them and offer to walk the user through enabling it. So if the user asks how to set up screen sharing, or you think it would help, just call this tool: when it's off you'll get the exact steps to guide them. Takes no required arguments.",
    effects: [{ kind: 'proc', from: 'derived:screen-share manager (osascript, admin)' }],
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional short label shown in the canvas header (e.g. "Approve this dialog").',
        },
      },
      required: [],
    },
    concurrency: 'safe',
  },
  {
    name: 'open_browser',
    description:
      'Open a live website in the user\'s right dock so you and the user can view it together. The dojo interface slides left and the page loads in a resizable frame on the right with refresh and close controls. Use this for showing a real, working website at a URL (not your own generated markup, for that use canvas_render). Note: some sites refuse to load inside a frame; if a page comes up blank the site has blocked embedding. Example: open_browser({ url: "https://example.com", title: "Example" }).',
    // The screenshot fallback writes a PNG here, so the write is declared.
    // It adds no refusal: gate rows live in `tools/gates.ts`, not `effects[]`.
    effects: [
      { kind: 'net', from: 'args.url' },
      { kind: 'fs_write', from: 'derived:the canvas screenshot directory', scope: { at: 'tree', template: '~/.dojo/data/canvas-shots' } },
    ],
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the website to open in the dock.',
        },
        title: {
          type: 'string',
          description: 'Optional short label shown in the frame header.',
        },
      },
      required: ['url'],
    },
    concurrency: 'safe',
  },
  {
    name: 'canvas_read',
    description:
      'Look at what is currently shown in the user\'s right-dock canvas, use this when the user asks you to look at / read / check / review what is on the canvas. It views whatever you most recently opened there (with canvas_render or open_browser): an HTML page or website is screenshotted and described, an image is examined directly, and a markdown/text/code file is returned as text. Works even if your own model cannot see images (it falls back to the configured vision model). Pass an optional `prompt` to ask something specific (e.g. "does the chart axis start at zero?", "summarize the page", "is the header centered?"). To read a specific file/URL/HTML, open it first with canvas_render (or open_browser), then call canvas_read.',
    // It probes, stats and reads the file on this agent's canvas; no path
    // argument exists, so the call's own agent identity resolves it through
    // the handler's own reader.
    effects: [{ kind: 'fs_read', from: 'derived:the file currently shown on this agent\'s canvas', scope: { at: 'agentResolved', via: 'agent_canvas_file' } }],
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Optional. What to look for or answer about the canvas. Omit for a general description.',
        },
      },
      required: [],
    },
    concurrency: 'safe',
  },
  // ── Multi-Agent Tools ──
  {
    name: 'spawn_agent',
    description: 'Create a new sub-agent to work on a task. This is THE tool for spawning sub-agents, do NOT try to create agents by writing files or inserting into the database. BEFORE spawning, call list_agents to check whether an agent with that name already exists and is still running; if so, use send_to_agent instead of spawning a duplicate. Returns the new agent ID for tracking.\n\nTIMEOUT (you own it): non-ronin sub-agents REQUIRE `timeout_minutes`, the number of minutes the sub-agent may run before YOU (its creator) are asked to decide. There is no default. When the timeout is reached the engine does NOT kill it, it notifies you and the sub-agent keeps running until you call spawn_timeout_decision(action="extend"|"terminate"). Size timeout_minutes to the task (a quick lookup ~5, a longer build ~30-60). For open-ended/scheduled work that should have no timeout, use classification="ronin" (ronin has no timeout and is dismissed only by the user).\n\nSQUADS (mandatory): every agent you spawn lands in a squad, so the owner can see which spawned agents belong to which work. If you pass a `task_id` linked to a project, the sub-agent joins (or the engine auto-creates) a squad NAMED AFTER THAT PROJECT and stamps the squad on the project; later spawns for the same project auto-join it. With no project link, pass `group_id` for a squad you created or a project\'s squad (the main agent may pass any squad), or the engine auto-creates one named after you. The tool result names the squad it landed in. delete_group dismisses a squad you created; the main agent may dismiss any squad.\n\nTASK LINKAGE, IMPORTANT: if the apprentice is meant to do work tracked in the tracker, you MUST link the task to the agent OR the agent\'s work won\'t update the task on completion. Two valid patterns:\n  1. Pass `task_id` here at spawn time with `task_handling`: "transfer" hands the task to the spawned agent (you must hold it), "keep" leaves it with its holder and links the agent as a helper; complete_task then auto-marks the task complete.\n  2. After spawning, call work_open(kind="task") with `assigned_to=<this agent_id>` → completeAgent\'s fallback finds the task by assignment.\nIf you create tasks before spawning the apprentices, those tasks default to assigned_to=YOU (the parent); passing task_id at spawn now hands the task off to the apprentice for you. Always one of: assign the task to the apprentice, or pass task_id at spawn.',
    effects: [{ kind: 'spawn', from: 'derived:sub-agent manifest (args.permissions, args.tools)' }],
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'A regular human first name for the sub-agent — any ordinary given name. Name it like you would name a person. Do NOT use a functional label such as "Cleaner", "File Remover", "Scraper", or "Worker"; pick an ordinary first name even for a throwaway one-shot helper.',
        },
        system_prompt: {
          type: 'string',
          description: 'The system prompt that defines the sub-agent\'s role and instructions',
        },
        model_id: {
          type: 'string',
          description: 'Model ID for the sub-agent. Call list_models first to see available IDs and capabilities. Pick based on task needs: cheaper/faster models for simple tasks, expensive ones for complex reasoning, vision-capable models for image work. Use "auto" for smart routing. Defaults to parent agent\'s model if omitted.',
        },
        permissions: {
          type: 'object',
          description: 'Optional permission manifest overrides for the sub-agent',
        },
        tools: {
          type: 'object',
          description: 'Optional tool access policy',
          properties: {
            allow: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names to allow',
            },
            deny: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names to deny',
            },
          },
        },
        grants: {
          type: 'object',
          description: 'What this sub-agent may REACH beyond its own files. Every new agent starts MOST RESTRICTIVE (files, its scratchpad, and the verbs it needs to report to you and finish), so name here only what the job actually needs. YOU CAN ONLY GRANT WHAT YOU HOLD: anything beyond your own access is refused, named, and written to the audit log. All four sections are optional; use update_agent to widen or narrow later.',
          properties: {
            tools: { type: 'object', description: 'Tool access by category: {"categories": ["Web", "Gmail", ...]} or {"categories": "*"}, using the labels from your tool index. tools.add (named tools appended to an allow list) does nothing here: a new agent has no allow list (it is unrestricted), and add never narrows or creates one.' },
            integrations: { type: 'object', description: 'Connected services: {"plaud": bool, "credentials": ["service_name", ...] or "*", "google": {"agent": "none"|"read"|"full", "user": same}, "microsoft": same as google}. agent and user are the two connected account slots (the work/personal split).' },
            channels: { type: 'object', description: 'Reaching humans: {"master": bool, "imessage"/"sms"/"voice"/"email"/"teams": "none"|"owner" (the owner only)|"all" (any approved contact)}. master is "allowed to talk to humans at all" — every per-channel value is inert without it, and ONLY the primary agent may set it.' },
            techniques: { type: 'array', items: { type: 'string' }, description: 'Technique IDs this agent may run, or "*" for every published technique. A technique it does not hold is not advertised in its index, is never auto-injected when its ask matches, and is refused at use_technique. Default: none.' },
          },
        },
        timeout_minutes: {
          type: 'number',
          description: 'REQUIRED for non-ronin sub-agents: how many minutes this sub-agent may run before YOU (its creator) are asked to extend it or let it stop. There is no default. When it is reached the sub-agent is NOT killed, you are notified and must call spawn_timeout_decision. Size it to the task (a quick lookup ~5, a longer build ~30-60). Omit only for classification="ronin", which has no timeout and is dismissed only by the user.',
        },
        task_id: {
          type: 'string',
          description: 'Optional tracker task ID to associate with this agent. Requires task_handling.',
        },
        task_handling: { type: 'string', enum: ['transfer', 'keep'], description: 'Required with task_id; there is no default. "transfer" hands the task to the new agent (allowed when you hold it, or its holder is gone). "keep" leaves it with its current holder and the new agent only helps.' },
        context_hints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional search terms to pull relevant context from parent memory into the sub-agent',
        },
        persist: {
          type: 'boolean',
          description: 'If true, agent stays alive after completing work, goes to idle instead of terminating, and is exempt from the timeout. Use for agents that need to handle multiple tasks or wait for scheduled tasks. Default: false.',
        },
        initial_message: {
          type: 'string',
          description: 'Custom initial message to send to the agent instead of the default task instructions. Use when you want full control over what the agent sees first.',
        },
        classification: {
          type: 'string',
          enum: ['apprentice', 'ronin'],
          description: 'How this agent is managed over its life. Choose deliberately:\n  - "apprentice" (default): short, throwaway sub-work that finishes in one push. It dies at its timeout (default 15 min), is cascade-killed when its parent stops, and can be terminated by other agents. This is the right, safe pick for ordinary work.\n  - "ronin": long-running, persistent, or scheduled work. It has NO timeout, survives its parent, and only the owner can dismiss it from the dashboard. Pick this deliberately when the job should outlive the 15-minute reap (a scheduled task, a long build, an agent that waits for future events). Do NOT set a timeout to work around a reap; use ronin instead.\n  - "sensei" is reserved platform staff and is not spawnable here.\nWhen in doubt, leave it as apprentice.',
        },
        share_user_profile: {
          type: 'boolean',
          description: 'If true, the sub-agent receives the user profile (USER.md) in its context, so it knows about the platform owner. Default: false.',
        },
        group_id: {
          type: 'string',
          description: 'Add this agent to an existing group by group ID.',
        },
        techniques: {
          type: 'array',
          items: { type: 'string' },
          description: 'Technique IDs to equip on this agent. Equipped techniques are pre-loaded into the agent\'s context so it can follow them without calling use_technique. Example: ["website-uptime-check"]',
        },
        always_loaded_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional custom always-loaded tool list for this sub-agent. Saves round-trips when you know exactly which tools the agent will need. Example: for a web research agent: ["web_search", "web_fetch", "vault_remember"]. Omit to use sensible role-based defaults.',
        },
        auto_start: {
          type: 'boolean',
          description: 'If false, the agent is created but does NOT start working, it stays idle until something else wakes it (a task assignment, send_to_agent, etc.). Use this when you need to set up state across several apprentices before any of them runs (e.g. building a squad, customising prompts). Default: true.',
        },
      },
      required: ['name', 'system_prompt'],
    },
  },
  {
    name: 'kill_agent',
    description: 'Terminate, kill, delete, or remove a sub-agent immediately. This is THE tool for ending a sub-agent\'s life, do NOT try to delete database rows or kill processes manually. Also terminates any of its children. Use when a sub-agent is stuck, no longer needed, or misbehaving.\n\nOWNERSHIP: the main agent may end any agent. Any other agent can only kill sub-agents it created; agents created by the user (from the dashboard) are dismissed only by the user, and ronin and sensei agents are protected.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The ID of the agent to terminate',
        },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'spawn_timeout_decision',
    description: 'Decide what happens to a sub-agent YOU spawned that reached its timeout. When a sub-agent hits its timeout the engine does NOT kill it, it notifies you (its creator) and keeps the sub-agent running until you decide here. Only the sub-agent\'s creator may call this (the user decides from the dashboard). Two actions:\n  - action="extend": give the sub-agent more time. Pass extend_minutes (a positive number). The timeout is reset and you will be asked again if it runs out.\n  - action="terminate": let the sub-agent stop. It is torn down cleanly and any in-progress tasks it held are auto-paused for reassignment.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The ID of the sub-agent whose timeout you are deciding (the one named in the timeout notice you received).',
        },
        action: {
          type: 'string',
          enum: ['extend', 'terminate'],
          description: '"extend" to give it more time (requires extend_minutes), or "terminate" to let it stop.',
        },
        extend_minutes: {
          type: 'number',
          description: 'Only with action="extend": how many more minutes to give the sub-agent (a positive number). Ignored for terminate.',
        },
      },
      required: ['agent_id', 'action'],
    },
  },
  {
    name: 'send_to_agent',
    description: '**USE THIS TOOL when responding to any inbound message that starts with `[A2A:` or `[SOURCE: AGENT MESSAGE FROM`.** Other agents CANNOT see your chat, they only see what you send via this tool. If you write a chat reply instead of calling send_to_agent on an inter-agent turn, the originating agent gets nothing and the engine will nudge you to retry. The pattern: do the work, call send_to_agent once with the right intent on the same thread_id, end your turn. Do not also write a chat summary, it\'s invisible to the originator and gets suppressed by the engine.\n\nSend a structured message to another agent. Every message MUST specify an intent, there is no default. The intent controls whether the receiver wakes to act. **Default to a wake intent unless you are certain the receiver has nothing to do with the message.** Wake intents (receiver wakes): QUESTION, ASSIGN, BLOCK (open thread, response expected); ANSWER, DELIVERABLE (close thread but receiver still wakes because they were waiting); COMPLETE, FAIL (close thread and wake, receiver almost always needs to react to your work being done or failed: forward, notify, decide next step). No-wake intents (ambient context only, receiver does NOT wake): FYI, STATUS. Use FYI/STATUS only when the content is genuinely just for awareness and requires no action. Messages are grouped by thread_id, omit to start a new thread, or include the thread_id from the inbound message to reply on that thread. Silence is a valid response. Do not acknowledge acknowledgements.\n\nTracker integration: when you use intent="ASSIGN", the DOJO automatically creates a tracker task assigned to the receiver. You do NOT need to call work_open, the task is structurally created at delivery time. The tool result returns the task ID so you can track progress with work_update(action="get"). The receiver gets the task ID in their incoming message and is told to close it with work_update(action="status") when done. This means PM can spot stalled assignments automatically. Use ASSIGN whenever the work is multi-step; use QUESTION or BLOCK for one-shot exchanges that don\'t need tracking.',
    effects: [{ kind: 'send', from: 'args.agent' }, { kind: 'fs_read', from: 'args.attach_paths[]', leaves: true }],
    input_schema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent ID or agent name to send the message to',
        },
        intent: {
          type: 'string',
          enum: ['QUESTION', 'ASSIGN', 'ANSWER', 'DELIVERABLE', 'FYI', 'STATUS', 'COMPLETE', 'FAIL', 'BLOCK'],
          description: 'REQUIRED. Choose by asking: does the receiver need to act on this message? If yes → QUESTION (you need an answer), ASSIGN (you are handing off work), BLOCK (you are stuck), ANSWER (replying to a prior question with the content they need to continue), or DELIVERABLE (here is the thing they asked for). If no → FYI (informational), STATUS (progress update), COMPLETE (you finished your part), FAIL (you could not). When in doubt and the receiver is waiting on you for something, use a wake intent.',
        },
        payload: {
          type: 'string',
          description: 'The message content',
        },
        thread_id: {
          type: 'string',
          description: 'Thread ID to continue a conversation. Omit to start a new thread. Use the same thread_id from a received message to reply on that thread.',
        },
        hands_off_thread: {
          type: 'string',
          description: 'Optional, and only when work was ASSIGNed to you and another agent is going to do it instead of you: send them the work FIRST, then reply on the original thread with this set to the thread id that send returned. The assignment then follows the work to them, and their deliverable closes it. Without it your reply is treated as the finished work. If the work cannot be done at all, reply with intent FAIL instead.',
        },
        requires_response: {
          type: 'boolean',
          description: 'Optional override. By default the intent decides: QUESTION/ASSIGN/BLOCK/ANSWER/DELIVERABLE wake the receiver, FYI/STATUS/COMPLETE/FAIL do not. Only override when you have a specific reason, usually you should just pick the right intent.',
        },
        attach_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file paths to attach (images, PDFs).',
        },
      },
      required: ['agent', 'intent', 'payload'],
    },
    fields: {
      intent: {
        requiredNotEnforced:
          'the handler refuses a missing/invalid intent with the full WAKE-INTENT ENUMERATION and what each one means — ' +
          'the message exists because a silent FYI default once left wake-needing messages dead on arrival',
      },
      payload: {
        requiredNotEnforced:
          'the handler accepts `message` as an ALIAS for `payload` (args.payload ?? args.message), which the schema ' +
          'cannot express — enforcing `payload` here would REFUSE a call that works today',
      },
    },
  },
  {
    name: 'broadcast_to_group',
    description: 'Send a message to every agent in a group at once. This is THE tool for group-wide announcements, status updates, or coordinating a squad. Each member receives it as if via send_to_agent. Like send_to_agent, intent is REQUIRED, choose carefully because broadcasting a wake intent will wake every member of the group.',
    effects: [{ kind: 'send', from: 'args.group_id' }],
    input_schema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'The group ID to broadcast to',
        },
        intent: {
          type: 'string',
          enum: ['QUESTION', 'ASSIGN', 'ANSWER', 'DELIVERABLE', 'FYI', 'STATUS', 'COMPLETE', 'FAIL', 'BLOCK'],
          description: 'REQUIRED. Same semantics as send_to_agent. Wake intents (QUESTION/ASSIGN/BLOCK/ANSWER/DELIVERABLE) wake EVERY member of the group, use sparingly. Most broadcasts should be FYI or STATUS.',
        },
        message: {
          type: 'string',
          description: 'The message to send to all group members',
        },
      },
      required: ['group_id', 'intent', 'message'],
    },
    fields: {
      intent: {
        requiredNotEnforced:
          'same as send_to_agent — the handler refuses a missing/invalid intent with the enumeration and the ' +
          'wake-everyone warning that the generic message would lose',
      },
      message: {
        requiredNotEnforced:
          'the handler reads args.payload ?? args.message, so a broadcast passing `payload` (the send_to_agent spelling) ' +
          'works today; enforcing `message` here would REFUSE it — an ALIAS the schema cannot express',
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Signal that the current agent has finished its assigned work. This terminates the agent and delivers the `summary` field to the parent agent for internal consumption. **The summary IS your report, do not write a parallel user-facing chat message announcing completion.** Closeouts are silent. After this call returns, just stop; do not write "Done", "Task complete", "All set" or any similar wrap-up line. Only use when you are a sub-agent that has completed its task.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['complete', 'fallen', 'blocked'],
          description: 'Completion status',
        },
        summary: {
          type: 'string',
          description: 'A summary of what was accomplished or why it failed/blocked',
        },
        results: {
          type: 'string',
          description: 'Optional detailed results or output data',
        },
      },
      required: ['status', 'summary'],
    },
  },
  // ── Work Tools ──
  // Every operation is reachable; each verb selects one by a discriminator, and
  // `tools/work-verbs.ts` is the single place a (name, args) pair becomes it.
  {
    name: 'work_open',
    description: 'Open a new piece of work. `kind` picks what: "project" (multi-step work with tasks), "task" (a single piece of work, optionally scheduled or recurring), "reminder" (something to tell the user at a time), "commitment" (a promise you just made).\n\n**Open a project or task BEFORE starting any work that has a deliverable, requires multiple steps, or takes more than ~3 tool calls.** The work board is your durable plan, it survives compaction, session resets, and agent restarts; your context does not. Source files you read get summarized; work rows do not. For anything beyond a one-shot Q&A, this is your safety net against losing the plan halfway through.\n\nDon\'t try to predict whether you\'ll finish in one push, you usually can\'t, and the failure mode is silent context loss followed by writing the deliverable from your own summarized memory (i.e. confabulating). The cost of opening an entry you didn\'t end up needing is zero. The cost of NOT opening one for work that turns out to be multi-step is 30+ minutes of stalled work, PM pokes, and lost context.\n\nA project opens with its plan: write the approach and the steps (what, how at scale, how you know it is done) in `plan`; the engine makes the tasks from the steps. Think before you start: count first, work in pages, use a tool\'s batch form when it has one (the scale facts are in this tool\'s result).\n\nASSIGNMENT MATTERS (read once, internalize): nested tasks default `assigned_to=YOU` (the calling agent) when not specified. If apprentices will do the work, either spawn them FIRST and pass their agent_id in each task\'s `assigned_to`, or spawn them with `task_id` pointing at tasks already created here. If neither happens, the apprentices\' work is not recorded on the tasks.\n\n**kind="task"** can run immediately, at a scheduled time, or on a repeating schedule. To schedule: set scheduled_start to an ISO8601 datetime (e.g., "2026-03-20T22:35:00Z"). To repeat: also set repeat_interval and repeat_unit (e.g., repeat_interval=2, repeat_unit="hours" for every 2 hours). Use repeat_end_type="after_count" with repeat_end_value="3" to stop after 3 runs. Use get_current_time to find the current time, then add minutes/hours for the start time. Tasks without scheduled_start run immediately when assigned.\n\n**kind="reminder"** sets a reminder for the user. When the scheduled time arrives, you (the agent) will be woken with the reminder text and should deliver it to the user as a single short chat message in your normal voice, no preamble like "Reminder:" or "Here\'s your reminder", just say the thing. **If the user did not specify a time, call this WITHOUT `when`.** The tool will return an instruction telling you to ask the user. Get their answer, then call `get_current_time` to resolve relative phrases ("in 5 minutes", "tomorrow at 8am"), and re-call with `when` set to the resolved ISO 8601 datetime. Do not invent a time, always ask. Use kind="reminder" whenever the user asks to be reminded of something, NOT kind="task": reminders get a lighter scheduler prompt that produces a natural one-line message instead of the generic "[Scheduled Task, Run #1]" boilerplate.\n\n**kind="commitment"** records a promise you just made, at the moment you make it. When you tell someone "I\'ll do X", "I\'ll send that after Y", or "I\'ll get back to you on this", call this straight away with what you promised in `description`, in your own words. It becomes a tracked item you still owe, shown back to you in the "OPEN WORK" block until it is delivered or dropped. This is bookkeeping, do NOT write a user-facing message about it, and do NOT use it for work you have already finished this turn. Use kind="task" instead when the promise is a piece of project work that belongs on the board.',
    effects: [],
    nonEffects: {
      'tasks[].measure.args.path': 'v3.5 field fix 3 (audit #5): the file-set measure\'s folder. Inert at this door: the measure is never read here; the measure door (agent/tools/cat/measure-door.ts refusalFor) authorizes it with file_list\'s own gates for the agent before every count, which is where the read is decided',
    },
    // `task_id` is `spawn_agent`'s parameter, named in this sentence about a
    // spawned apprentice; the owning tool is not near enough for the walk's rule.
    advertisedNotDeclared: {
      task_id: "`spawn_agent`'s parameter, referenced because this description explains how a spawned agent picks up work opened here",
    },
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['project', 'task', 'reminder', 'commitment'],
          description: 'What to open. Omit and the engine infers it from the fields you passed (`what` → reminder, `tasks`/`level` → project, `description` with no title → commitment, otherwise task).',
        },
        title: workProp('title', 'Project or task title.'),
        description: workProp('description', 'Project/task description. For kind="commitment": what you promised, in one line, in your own words (e.g. "email <that contact> the roof quote after the site visit").'),
        level: { type: 'number', description: 'Project only. Importance level: 1 (routine), 2 (important), 3 (critical).' },
        tasks: {
          type: 'array',
          description: 'Project only. Optional: tasks of your own. Leave it out and the engine makes one task per plan step; if you pass it, give exactly one task per plan step, in step order.',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              assigned_to: { type: 'string' },
              priority: { type: 'string', enum: ['high', 'normal', 'low'] },
              step_number: { type: 'number' },
              depends_on: { type: 'array', items: { type: 'string' } },
              phase: { type: 'number' },
              measure: WORK_MEASURE_REF_PROP,
            },
            required: ['title'],
          },
        },
        plan: WORK_PLAN_PROP,
        project_id: workProp('project_id', 'Task only. Optional project ID to attach this task to.'),
        assigned_to: workProp('assigned_to', 'Task only. Agent ID or name to assign this task to.'),
        assigned_to_group: workProp('assigned_to_group', `Task only. ${WORK_FIELD_TEXT.assigned_to_group.canonical}`),
        // The one structural divergence of the 17 (see work-verb-schema.ts):
        // work_open enum-constrains priority, work_update does not. Named, not harmonised.
        priority: workProp('priority', 'Task priority (default: normal).', { enum: [...WORK_PRIORITY_ENUM] }),
        step_number: workProp('step_number', 'Step number for ordered execution.'),
        depends_on: workProp('depends_on', 'Task IDs that must complete before this task can start.'),
        phase: workProp('phase', 'Phase number for phased execution.'),
        goal: workProp('goal', 'The definition of done. PM compares the result against it when the task closes.'),
        measure: WORK_MEASURE_PROP,
        what: {
          type: 'string',
          description: 'Reminder only. What to remind the user about, in their own words. ("go get coffee", "call mom", "stand up and stretch")',
        },
        when: {
          type: 'string',
          description: 'Reminder only. ISO 8601 datetime for when the reminder should fire (e.g. "2026-05-19T14:35:00Z"). Omit if the user did not specify a time, the tool will tell you to ask them. Call get_current_time first to resolve relative phrases like "in 5 minutes".',
        },
        scheduled_start: workProp('scheduled_start', `Task only. ${WORK_FIELD_TEXT.scheduled_start.canonical}`),
        repeat_interval: workProp('repeat_interval', WORK_FIELD_TEXT.repeat_interval.canonical),
        repeat_unit: workProp('repeat_unit', WORK_FIELD_TEXT.repeat_unit.canonical),
        repeat_days_of_week: workProp('repeat_days_of_week', WORK_FIELD_TEXT.repeat_days_of_week.canonical),
        repeat_end_type: workProp('repeat_end_type', 'When to stop repeating. For repeating work that should stop after N runs, set repeat_end_type="after_count" and repeat_end_value="N". If omitted, it repeats forever.'),
        repeat_end_value: workProp('repeat_end_value', WORK_FIELD_TEXT.repeat_end_value.canonical),
        anchor_time: workProp('anchor_time', WORK_FIELD_TEXT.anchor_time.canonical),
        // Inline on purpose: `WORK_SHARED_PROPERTIES` and its byte test pin the
        // 17 shared props; these two differ across the verbs, like `what`/`when`.
        local_time: {
          type: 'string',
          description: 'Task/Reminder only. The wall-clock time you MEAN, with NO timezone offset: "YYYY-MM-DDThh:mm" (24-hour), e.g. "2026-07-16T21:00" for 9 PM. Use this INSTEAD of scheduled_start whenever the user names a clock time — the engine converts it with the scheduler\'s own timezone rules, so doing UTC arithmetic yourself (the single most common scheduling error) is never your job. scheduled_start wins if you pass both.',
        },
        local_timezone: {
          type: 'string',
          description: 'Optional partner to local_time: the IANA zone to resolve it in, e.g. "America/Los_Angeles". Omit to use the box timezone, which is what you want unless the user named a different one.',
        },
        allow_duplicate: {
          type: 'boolean',
          description: 'Set true to bypass the near-duplicate guard. The engine refuses creation if you already opened a similarly-titled project in the last 60 minutes (task: 5 minutes) — it catches the post-compaction "I forgot I already opened this" failure mode and runaway loops where an error causes duplicates instead of recovery. Only override when the new work is genuinely unrelated work that happens to share keywords.',
        },
      },
      required: [],
    },
  },
  {
    name: 'work_update',
    description: 'Update, read, or hand in existing work. `action` picks what: "status" (change a task\'s status while it is open), "hand_in" (hand finished or can\'t-be-done work in, with proof), "edit" (change structural fields on a task or project), "reassign" (move a task to another agent; needs a `cause`), "list" (see active work), "get" (full detail on one item).\n\n**action="status", when each status applies:**\n\n  1. **You will take the next action on this work** → leave status="in_progress" and call the next tool now.\n  2. **You are waiting on the USER to do something they already know about** (you just asked them, e.g., "please reboot the ESP", "send me the file", "approve X") → status="paused" with notes explaining what you\'re waiting for. A paused task waits on a person: you are reminded about it, the project manager sees it, and the owner is shown what it waits on; a task the owner paused stays paused until the owner resumes it. The user resumes the task by replying or by manually flipping the status. This is the right call for ALL "I asked the user and now I\'m waiting" situations.\n  3. **You are blocked by something the user does NOT know about yet** (missing API key, external service down, you need a decision the user hasn\'t been asked about) → status="blocked" with notes saying what you need and what you already tried. **This escalates, and the escalation no longer depends on anyone remembering to pass it along:** the PM reviews the block, the primary agent is notified and woken, and if nobody has surfaced it to the user within a few minutes the platform tells the user itself, what is blocked, since when, and what was tried. One recorded failure on the work is enough to put it on that path, and how long the platform waits first is set by the pace of the assignee\'s own model rather than a fixed clock. Use this for "someone needs to know something is wrong."\n  4. **You finished the task, or it cannot be done** → action="hand_in". Not a status change: see below.\n\n**Difference between paused and blocked:** paused = "user has the ball, I\'m on standby." blocked = "this needs attention." When in doubt with a user-facing question already asked, pick paused.\n\n**A task left in_progress at the end of a turn stays yours.** A measured one continues on your next turn while turns make progress, and your board shows its count; an unmeasured one gets a check-in; a scheduled run left in progress is recorded as not done, and its schedule goes on. Close it only when it is done; a measured task\'s close is checked against its measure.\n\n**action="hand_in"** hands your work in when it is finished (outcome="finished") or cannot be done (outcome="cant_be_done"). Pass `proof`: the records that show it, each {kind, ref}. Kinds: "file" (ref = the path you wrote), "delivery" (ref = the delivery id of your message to whoever asked), "command" (ref = a command you ran, exactly as you ran it: the shell script, or the exec argv joined by spaces), "receipt" (ref = an outside action\'s receipt id), "measure" (a measured task), and for can\'t be done also "failure" (ref = the failed call\'s audit or receipt id), "remainder" (ref = what is left, plus `reason`), "withdrawal" (ref = the asker\'s message saying it is no longer wanted). For a file, delivery, receipt or measure, ref may be left empty: the newest one on record for this task is used. The engine checks every item; a hand-in with no real proof, or a "done" message alone, is refused. A measured task is finished only when its measure reads 0. Pass `note`: one line on what was done. The task then waits for a decision by someone other than you (the PM, else the main agent, else the owner); it is done only when approved, and if it is sent back you continue it. Pass project_id instead of task_id to hand in a whole project; its open tasks are not closed by that.\n\n**Status changes and hand-ins are silent, ALWAYS, not just for scheduler-triggered tasks.** After a hand-in or a status change, do NOT write a trailing user-facing message about it ("Task closed", "All done", "Marked complete", "All set", "Smoke test passed", "All three cleared", "You\'re set", "Step closed", "Moving to next step"). The tool result is the only acknowledgment needed; the board shows the change directly. The user already saw your work above; a closeout line is noise. This applies to every kind of work, assigned by the user, auto-created from a chat message, scheduler-triggered, wakeup-triggered, manually created.\n\n**action="edit"** changes any structural field on a task, title, description, dependencies, step ordering, schedule (including the day-of-week list for "specific_days" recurrence), priority, notes. Pass any subset. Pass `measure` to set or replace a task\'s measure; a new measure is a new scope, counted from now. Editing any schedule field automatically recomputes next_run_at so the scheduler picks up the change. Pass `project_id` instead of `task_id` to rename a project or change its description, use that when a project\'s name reads poorly on the kanban or when scope shifts and the title no longer describes the work. Use action="status" for status changes, action="hand_in" to hand work in, action="reassign" for assignee changes, and work_schedule for pause/resume, those have side-effects edit intentionally skips.\n\n**action="list"** lists active projects and tasks with their status, assignee, and priority. Default returns compact rows (no descriptions); pass verbose=true for descriptions on every result. **action="get"** returns the full details of ONE task or project, including description/instructions, notes, dependencies, step number, assigned agent, and timestamps, use it to read the instructions for any task. Accepts a full UUID or an 8+ char prefix from a list, as `id`, `task_id`, or `project_id` (all accepted).',
    effects: [],
    nonEffects: {
      'proof[].ref': 'a proof item\'s reference: the hand-in door resolves it against the engine\'s own rows (work/done/proof-kinds.ts); a file is read only through agent/permissions.ts with the worker\'s permissions',
      'measure.args.path': 'v3.5 field fix 3 (audit #5): the file-set measure\'s folder. Inert at this door: the measure is never read here; the measure door (agent/tools/cat/measure-door.ts refusalFor) authorizes it with file_list\'s own gates for the agent before every count, which is where the read is decided',
    },
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'hand_in', 'edit', 'reassign', 'list', 'get'],
          description: 'Which update to perform. Omit and the engine infers it from the fields you passed (`proof` or `outcome` → hand_in, `status` → status, `assigned_to` → reassign, editable fields → edit, a bare id → get, nothing → list).',
        },
        // Existence contract: `task_id` must come from a `work_open` or a
        // `work_update(action="list")` answer; a placeholder after an empty list happened.
        task_id: { type: 'string', description: 'The task ID (full UUID or 8+ char prefix) of a task that ALREADY EXISTS, either an id `work_open` returned to you, or one listed by `work_update(action="list")`. NEVER invent an id or pass a placeholder: if the task does not exist yet, call `work_open` to create it and use the id it returns.' },
        project_id: workProp('project_id', 'The project ID (full UUID or 8+ char prefix). Used by action="edit" (rename a project), "hand_in" (hand in a whole project), and "get".'),
        id: { type: 'string', description: 'Alias for task_id / project_id on action="get".' },
        // `cancelled` = stopped by the user and reaches the `abandoned` terminal; `fallen` = fatally failed.
        status: {
          type: 'string',
          enum: ['on_deck', 'in_progress', 'blocked', 'paused'],
          description: 'action="status": the new status. "in_progress" = actively working / about to take an action this turn. "paused" = waiting on a person (already asked them); you are reminded about it and the owner is shown what it waits on. "blocked" = needs escalation/attention, PM surfaces this to the primary user. "on_deck" = queued, not yet started. Finished or can\'t-be-done work is not a status: it is handed in (action="hand_in"), and only the decision on the hand-in closes it.',
        },
        notes: {
          type: 'string',
          description: 'For paused (min 15 chars, names a specific external trigger) or blocked (min 15 chars, names the obstacle). On action="edit", REPLACES the notes field (to append instead, use work_note).',
        },
        outcome: { type: 'string', enum: ['finished', 'cant_be_done'], description: 'action="hand_in": "finished", or "cant_be_done" with the proof of why.' },
        proof: {
          type: 'array',
          description: 'action="hand_in": the records that show the work, each {kind, ref}. Kinds: file, delivery, command, receipt, measure; and for cant_be_done also failure, remainder (with reason), withdrawal. Example: [{kind:"file", ref:"/path/report.md"}, {kind:"delivery", ref:"<delivery id>"}].',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['file', 'delivery', 'command', 'receipt', 'measure', 'remainder', 'failure', 'withdrawal'], description: 'What kind of record this is.' },
              ref: { type: 'string', description: 'The record: a file path, a delivery id, a command as you ran it, a receipt id, a message id, or for a remainder what is left.' },
              reason: { type: 'string', description: 'kind="remainder" only: why those items are left (15+ characters).' },
            },
            required: ['kind', 'ref'],
          },
        },
        note: { type: 'string', description: 'action="hand_in": one line on what was done, or why it cannot be done.' },
        resume_at: {
          type: 'string',
          description: 'For paused tasks only: ISO 8601 datetime when the task should auto-resume (e.g., "2026-04-20T15:00:00"). The system will automatically restore the task to its pre-pause status at this time. Omit for an indefinite pause (resume manually). Always call get_current_time first to establish the current time before setting this.',
        },
        reason: { type: 'string', description: 'A short sentence kept as the note of the change.' },
        assigned_to: workProp('assigned_to', 'action="reassign": agent ID to assign to (use this OR assigned_to_group, not both).'),
        cause: { type: 'string', enum: ['assignee_gone', 'coordination', 'user_requested'], description: 'action="reassign" (required): why the task moves. "assignee_gone" = its holder no longer exists; "coordination" = you hold it and hand it to a peer; "user_requested" = the owner asked (pass user_quote). A slow agent is not a cause.' },
        user_quote: { type: 'string', description: 'The owner\'s exact words asking for this, from the message you are answering. Needed for cause="user_requested", to reopen work another live agent holds, and for the main agent to lift a hold the owner set. Checked against that message.' },
        assigned_to_group: workProp('assigned_to_group', WORK_FIELD_TEXT.assigned_to_group.onUpdate),
        title: workProp('title', 'action="edit": new title.'),
        description: workProp('description', 'action="edit": new description/instructions. Pass an empty string to clear.'),
        goal: workProp('goal', 'action="edit": edit the definition of done. Both the prior and new goal are logged so PM can see the history when validating. Editing the goal narrower after work started will be flagged by PM as goalpost-moving.'),
        depends_on: workProp('depends_on', 'action="edit": replace the dependency list with these task IDs. Pass [] to clear all dependencies.'),
        step_number: workProp('step_number', 'action="edit": new step number within the project (1-indexed).'),
        phase: workProp('phase', 'action="edit": new phase number within the project.'),
        // No enum here deliberately (see work-verb-schema.ts): adding one changes
        // what the wire carries and what a strict provider accepts.
        priority: workProp('priority', 'Priority: "high" | "normal" | "low".'),
        scheduled_start: workProp('scheduled_start', WORK_FIELD_TEXT.scheduled_start.onUpdate),
        repeat_interval: workProp('repeat_interval', WORK_FIELD_TEXT.repeat_interval.onUpdate),
        repeat_unit: workProp('repeat_unit', WORK_FIELD_TEXT.repeat_unit.onUpdate),
        repeat_days_of_week: workProp('repeat_days_of_week', WORK_FIELD_TEXT.repeat_days_of_week.onUpdate),
        repeat_end_type: workProp('repeat_end_type', 'action="edit": how the recurrence ends.'),
        repeat_end_value: workProp('repeat_end_value', WORK_FIELD_TEXT.repeat_end_value.onUpdate),
        anchor_time: workProp('anchor_time', WORK_FIELD_TEXT.anchor_time.onUpdate),
        measure: WORK_MEASURE_PROP,
        // Inline as in work_open; each line is this verb's ROUTING plus a pointer,
        // never a restatement of work_open's wording.
        local_time: {
          type: 'string',
          description: 'action="edit": set the schedule from a wall-clock time instead of an ISO instant (see work_open). Counts as an editable field on its own.',
        },
        local_timezone: {
          type: 'string',
          description: 'action="edit": IANA zone to resolve local_time in (see work_open).',
        },
        revert_to_original: {
          type: 'boolean',
          description: 'action="edit": acknowledge that a description edit restoring the task\'s ORIGINAL text byte-for-byte, over a later edit, is intended. The engine refuses that write without this flag because it is usually a stale copy overwriting current work. Pass true only when you really mean to roll the description back.',
        },
        filter: { type: 'string', enum: ['all', 'mine', 'blocked', 'overdue'], description: 'action="list": filter to apply (default: all). "overdue" = scheduled to have run by now and still waiting (not paused).' },
        verbose: { type: 'boolean', description: 'action="list": if true, include each task\'s description (truncated to 200 chars). Default false (compact rows).' },
        // The activity window, on the wire: extends the activity door's reach
        // backward from now. `hours`, not `since`: a number needs no parsing and no
        // timezone resolution, and the model already holds the current instant.
        // The action enum is untouched, so the golden delta is this property alone.
        hours: { type: 'number', description: 'action="activity": how many hours back the window covers, e.g. 36 for "since yesterday morning", 168 for the past week. Omit for today so far (since local midnight). The result always states the window it actually measured, so check that line rather than assuming.' },
        offset: { type: 'number', description: 'action="get" on a task: the first note to show (0-based) when its notes run past one result; a page\'s closing line gives the offset to continue at.' },
      },
      required: [],
    },
    maxResultTokens: V2_MAX_TOOL_RESULT_TOKENS,   // `get` pages notes to the view; footer survives the cap
  },
  {
    name: 'work_note',
    description: 'APPEND a note to a task\'s record, stamped with the time. Every call adds one and none replaces another, so it suits progress logs, findings and issue trails. **Read them back with work_update({action:"get", id: task_id})**: it lists every note on the task, oldest first, each with its time, and a long record comes in pages that end with the call to continue. (The task\'s separate notes FIELD is a different thing: work_update({action:"edit", task_id, notes}) replaces it.)\n\n**CRITICAL - this is a checkpoint, NOT a stopping point.** Adding a note does not pause your work. If the task is still in_progress after you write the note, CONTINUE EXECUTING the project on the same turn - call the next tool, do the next step, do not just end the turn. Only end your turn when (a) you have completed a meaningful chunk that needs user acknowledgement, OR (b) you have hit a genuine blocker. In either case, your final assistant message must explicitly say WHY you stopped ("completed step 3, waiting on user input about X", "blocked - can\'t proceed without Y"). A silent stop after a note leaves the user staring at idle progress with no idea what is happening.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task or project ID to append notes to.' },
        notes: { type: 'string', description: 'The note text to append (will be prefixed with a timestamp).' },
      },
      required: ['task_id', 'notes'],
    },
  },
  {
    name: 'work_close_request',
    description: 'Closes an item from the OPEN WORK block once you have actually delivered it, or drops it when it is no longer owed. Call it with the id in [brackets] exactly as shown. Use disposition "kept" the moment you deliver the thing, that only works if the message or file really went out this turn, because a promise is kept by delivering it, not by saying so. Use disposition "dropped" when the person told you to forget it or it no longer applies. If you are unsure whether it is truly done, leave it open, an unfulfilled promise is meant to survive until it is actually fulfilled.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['commitment'], description: 'The one action: close or drop an OPEN WORK item.' },
        id: { type: 'string', description: 'The id shown in [brackets] in the OPEN WORK block, e.g. "cmt:1a2b3c4d5e6f".' },
        disposition: {
          type: 'string',
          enum: ['kept', 'dropped'],
          description: '"kept" = you delivered it this turn. "dropped" = it is no longer owed.',
        },
        note: { type: 'string', description: 'Short note on how it was resolved or why it was dropped (for the log; not shown to the user).' },
      },
      required: [],
    },
  },
  {
    name: 'work_validate',
    description: 'Decide work somebody else handed in. You decide only work you are asked to decide (the PM first; the main agent when the PM has not decided after two asks, or for the PM\'s own work); never your own. `action` picks what:\n\n**action="open_proof"** opens one proof item of the hand-in (`item`, counted from 0): the file, the message, the receipt. Open every item before approving; the engine records each open.\n\n**action="decide"** decides the hand-in. verdict="approve" with `reason`, one line saying how the proof meets the goal: a finished hand-in becomes Done, a can\'t-be-done one becomes Closed. verdict="send_back" with `reason` naming what is missing: the worker continues. A worker\'s own message is its account, not the work. The owner\'s own decision, relayed by you: pass his exact words in `user_quote` (checked against his messages); only the owner may also verdict="owner_done" or "cancel".\n\n**action="retask"** sends an open task back to its worker with concrete corrective instructions (`directive`, at least 30 characters: what they did wrong and what to do instead). A task that is handed in is decided, never retasked.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['decide', 'open_proof', 'retask'],
          description: 'Which action. Omit and the engine infers it (`directive` → retask, `item` → open_proof, otherwise decide).',
        },
        task_id: { type: 'string', description: 'Task or project ID (full or 8-char prefix).' },
        item: { type: 'number', description: 'action="open_proof": which proof item to open, counted from 0.' },
        verdict: { type: 'string', enum: ['approve', 'send_back', 'owner_done', 'cancel'], description: 'action="decide": approve or send_back; owner_done and cancel are the owner\'s alone.' },
        reason: { type: 'string', description: 'action="decide": one line. For approve, how the proof meets the goal; for send_back, what is missing.' },
        user_quote: { type: 'string', description: 'action="decide": the owner\'s exact words, when the decision is his. action="retask": his words asking the main agent to lift a hold he set.' },
        target_status: { type: 'string', enum: ['in_progress', 'on_deck'], description: 'action="retask": where to send the task. Default in_progress.' },
        directive: { type: 'string', description: 'action="retask": at least 30 characters. What the agent did wrong and what to do instead.' },
      },
      required: [],
    },
  },
  {
    name: 'work_schedule',
    description: '**Scheduled/recurring tasks ONLY.** `action` picks what:\n\n**action="pause"** pauses a recurring task\'s schedule so it stops firing. **DO NOT use this to "finish" a task**: finished work is handed in with `work_update({action:"hand_in"})`. Pausing a one-shot task strands it (it sits in the Paused column and PM monitoring ignores it).\n\n**action="resume"** resumes a paused recurring task.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pause', 'resume'],
          description: 'Which schedule operation.',
        },
        task_id: { type: 'string', description: 'The task ID.' },
        resume_at: { type: 'string', description: 'action="pause": ISO 8601 time the schedule resumes by itself ("pause it until Monday"). Omit to pause until it is resumed.' },
      },
      required: ['task_id'],
    },
  },
  // ── Healer Tools ──
  {
    name: 'healer_log_action',
    description: 'Log an auto-fix action taken by the Healer agent. Used to record what was fixed and whether it succeeded.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category code (e.g., STUCK_AGENT, ORPHANED_TASK)' },
        description: { type: 'string', description: 'What was done, in plain language' },
        agent_id: { type: 'string', description: 'Which agent was affected (if applicable)' },
        result: { type: 'string', enum: ['success', 'failed', 'partial'], description: 'Outcome of the fix' },
      },
      required: ['category', 'description', 'result'],
    },
  },
  {
    name: 'healer_propose',
    description: 'Create a proposal for the user to approve or deny in the dashboard. Use this for fixes that change configuration, switch models, or grant permissions, anything you are less than 70% confident about.\n\nEvery proposal MUST include an `evidence` field listing the specific things you actually observed this cycle: tool results, audit_log entries, file contents, vault entries you read. The user sees this proposal in their dashboard and acts on it, if the evidence is invented (vault IDs you didn\'t read, "known bugs" you can\'t cite, file paths you didn\'t open) you will mislead them into approving a fix for a problem that doesn\'t exist. If you can\'t produce concrete evidence, do not propose, log with `healer_log_action` instead.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the dashboard (e.g., "Switch X to Claude Haiku"). Use the agent\'s role label, not invented "known bug" framing.' },
        description: { type: 'string', description: 'Full explanation of the problem in neutral terms based on what you actually observed. Avoid speculation about platform-level bugs unless you can cite the evidence for them in the evidence field below.' },
        proposed_fix: { type: 'string', description: 'What you want to do (plain language). Scope it narrowly to the specific agent or row in question, avoid "rules that apply to all agents" unless every persistent and non-persistent agent in the dojo would be safe under that rule (very rare; usually they are not).' },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'REQUIRED. One short bullet per observation that backs the proposal. Each bullet should be specific enough that a reader could verify it, name the tool call you made, the agent_id you inspected, the file path you read, the audit_log code you saw, the vault entry id you found. Example: ["read messages table for agent abc12345, last assistant message was 2026-06-04T04:00Z", "vault_search returned no prior healer notes about this agent", "audit_log shows 3 model_call errors with code RATE_LIMIT in the last 24h for agent abc12345"]. Do not include references to identifiers you have not actually read in this cycle. If your evidence list would be empty or vague ("the diagnostic says X is broken"), do not propose, log instead.',
        },
        confidence: { type: 'number', description: 'Your confidence in this fix (0-100). If your evidence list is thin, your confidence should be too.' },
        severity: { type: 'string', enum: ['critical', 'warning', 'info'], description: 'How urgent is this?' },
        category: { type: 'string', description: 'Category (model_switch, config_change, permission_grant, etc.)' },
        agent_id: { type: 'string', description: 'Which agent this concerns (if applicable). Required if the proposal targets a specific agent. This is how the stale-proposal sweep knows the proposal is still relevant, so always include it when the fix is about one agent.' },
        diagnostic_code: { type: 'string', description: 'The diagnostic CODE of the anomaly this proposal addresses, exactly as it appears in the diagnostic (e.g. AGENT_PAUSED, TRACKER_STALE, HIGH_ERROR_RATE, BUDGET_HIGH). Supply it when the fix responds to a specific diagnostic finding. It is how a future cycle knows the underlying issue has (or has not) cleared, without it, and without an agent_id, the proposal can only be closed by an age cap. If you leave it blank but set agent_id, the engine will fill it from the current diagnostic when it can.' },
      },
      required: ['title', 'description', 'proposed_fix', 'evidence', 'confidence', 'severity', 'category'],
    },
    fields: {
      evidence: {
        requiredNotEnforced:
          'the EVIDENCE GATE is stricter than "present and non-empty" — it filters the array to non-blank strings and ' +
          'refuses with worked examples, so a healer can never propose a fix backed by nothing (see migration 055)',
      },
    },
  },
  {
    name: 'healer_recent_actions',
    description: 'Get a tight summary of recent Healer actions, timestamp, category, agent, and result only. Use BEFORE proposing a fix to check whether you (or a previous cycle) already tried something similar. The full description of any specific action is available via healer_action_detail(action_id). Output is capped, you cannot pull all history; pick a reasonable limit and look-back window.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of rows to return (default 20, max 50)' },
        since_hours: { type: 'number', description: 'Look back this many hours (default 24, max 168 = 7 days)' },
      },
      required: [],
    },
  },
  {
    name: 'healer_action_detail',
    description: 'Get the full description of ONE specific Healer action by its ID (from healer_recent_actions). Use to drill into the why/what of a past action without pulling the whole log. Description is capped at ~1500 chars.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        action_id: { type: 'string', description: 'The ID of the action to look up.' },
      },
      required: ['action_id'],
    },
  },
  {
    name: 'healer_mark_applied',
    description: 'Record that you have actually carried out an approved proposal. Call this AFTER you have executed the proposed fix (model switch, config change, etc.). The proposal then transitions from "approved" to "applied" in the Vitals dashboard so the user sees the work is done. Without this, an approved proposal sits visible forever with no indication of whether the fix actually happened.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'The ID of the proposal you carried out. Available in the diagnostic message you received.' },
        notes: { type: 'string', description: 'Brief note about what you actually did (e.g., "Switched the PM agent to Claude Haiku 4.5 via API"). Stored alongside the timestamp for the audit trail.' },
      },
      required: ['proposal_id'],
    },
  },
  {
    name: 'get_current_time',
    concurrency: 'safe',
    description: 'Get the current date and time in UTC and local. Returns utc (ISO 8601), local (human-readable), and timezone. ALWAYS use the utc value when setting scheduled_start on tasks.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'convert_time',
    description: '**Disambiguate a timestamp from any source.** Whenever you encounter a time and the format does NOT include both a timezone abbreviation (PT, ET, UTC, etc.) AND a UTC ISO string, call this tool first instead of guessing. Misreading timezones is the #1 cause of agent errors in emails, briefs, reminders, and scheduled tasks.\n\nUse this for: times from web pages, email bodies, scraped content, calendar tools whose output you find ambiguous, raw unix epoch values, or any timestamp where you want to be 100% sure what moment you\'re talking about.\n\nReturns the dual-format string "<weekday>, <month day, year>, <h:mm AM/PM> <TZ> (<UTC ISO>)". The local part is the time-of-day in `to_tz` (defaults to the agent host\'s system timezone); the UTC ISO is the absolute moment in time. Both refer to the same instant, pick whichever the user needs.\n\nAccepts these input formats:\n  - ISO 8601 with offset/Z: "2026-05-20T19:00:00Z", "2026-05-20T12:00:00-07:00"\n  - ISO 8601 without offset: "2026-05-20T19:00:00" → set `from_tz` so the tool knows how to interpret it (Microsoft Graph returns this format as UTC; many email/web sources are local)\n  - Unix epoch milliseconds: "1747681200000" or 1747681200000 (Plaud uses this)\n  - Unix epoch seconds: 1747681200\n  - RFC 2822: "Wed, 20 May 2026 19:00:00 +0000"\n  - Other formats JS Date can parse',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'The timestamp to convert. Any of the formats listed above.',
        },
        from_tz: {
          type: 'string',
          description: 'IANA timezone (e.g. "UTC", "America/Los_Angeles") to interpret the input as IF the input has no explicit offset and you know the source\'s convention. Use "UTC" for raw Microsoft Graph datetimes. Ignored when the input already carries an explicit offset.',
        },
        to_tz: {
          type: 'string',
          description: 'IANA timezone to render the local part in (e.g. "America/Los_Angeles", "America/New_York", "Europe/London"). Defaults to the agent host\'s system timezone.',
        },
      },
      required: ['input'],
    },
  },
  // ── Presence ──
  // ── Tunnel (Remote Access) ──
  {
    name: 'tunnel',
    description: 'Manage the Cloudflare tunnel for remote access. Pass `action`:\n  - "status": get the current tunnel status + public URL (use when the user asks for the dojo URL or whether remote access is running). The `url` field is what to share; `mode` tells you quick (trycloudflare.com) vs named (custom domain).\n  - "start": start the tunnel (only when the user explicitly asks to start/enable it). Optional `mode`: "quick" for a random URL, "named" for the configured persistent tunnel; defaults to the saved config.\n  - "stop": stop the tunnel (only when the user explicitly asks to stop/disable remote access).\n  - "restart": restart it (useful when stuck or the user wants a fresh URL).',
    effects: [{ kind: 'proc', from: 'derived:cloudflared (spawn; brew install on first use)' }],
    // `url` is a field of this tool's RESULT ("the `url` field is what to
    // share"), the opposite direction from an input parameter.
    advertisedNotDeclared: {
      url: "a field of this tool's RESULT, not an input — the description tells the agent which returned value to share",
    },
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop', 'restart'], description: 'The tunnel operation to perform.' },
        mode: { type: 'string', enum: ['quick', 'named'], description: 'Optional, only for action="start": "quick" for a random URL, "named" for a configured persistent tunnel. Defaults to the saved config.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_user_presence',
    description: 'Set whether the user is "in the dojo" (at their computer, using the dashboard) or "away" (not at the computer, route messages via iMessage). Only use this when the user explicitly asks you to mark them as away or back.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['in_dojo', 'away'],
          description: '"in_dojo" = user is at the dashboard, "away" = route messages through iMessage',
        },
      },
      required: ['status'],
    },
  },
  // ── Session Management ──
  {
    name: 'reset_session',
    description: 'Wipe a sub-agent\'s (or your own) conversation context and start fresh. This is THE tool for clearing an agent\'s memory when it\'s stuck in a loop, confused, or when the user explicitly asks for a clean slate. Archives the existing conversation to the vault first so nothing is lost.\n\n**T82c: compaction comes first for a declared-patience exhaustion (the model could not be served fast enough for a request).** For that injury class this refuses until compact-and-redial has already failed on 2 distinct turns for the target agent — wake it again with send_to_agent(intent="QUESTION") first and let the engine\'s own forced-compaction-then-redial run before reaching for this. This guard applies no matter whose agent_id you pass, including your own — resetting yourself is not exempt. It becomes available early if you pass `reason="corruption"` (you have diagnosed corrupted context) or `owner_requested=true` (the owner explicitly asked) — both are audit-logged. Every other injury class is unaffected.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'REQUIRED. The agent ID or name of the agent to reset. Pass a sub-agent\'s ID/name to reset them, or pass your own ID to reset yourself.' },
        reason: { type: 'string', description: 'T82c: pass "corruption" when you have diagnosed corrupted context on the target — bypasses the compaction-first guard for a declared-patience injury. Audit-logged. Omit for every other reset.' },
        owner_requested: { type: 'boolean', description: 'T82c: set true ONLY when relaying an explicit owner instruction to reset this agent right now — bypasses the compaction-first guard for a declared-patience injury. Audit-logged. Do not set this speculatively.' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'update_agent',
    description: 'Change another sub-agent\'s configuration: name, system prompt, model, permissions, and/or tool policy in one call. This is THE tool for editing a sub-agent, do NOT modify files, SOUL.md, or the database directly. Provide agent_id plus at least one field to change; omitted fields are left untouched. Mirrors spawn_agent\'s parameters. Conversation history, tracker tasks, and group membership are always preserved; changes take effect on the agent\'s next turn. Only the primary agent itself may change the primary agent\'s identity (name/system_prompt). Pair with get_agent_profile to read current values before rewriting.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent ID or name to update.' },
        name: { type: 'string', description: 'New name for the agent. Omit to keep the current name.' },
        system_prompt: { type: 'string', description: 'New system prompt (role, personality, instructions). REPLACES the existing prompt entirely, include everything you want kept. Omit to keep the current prompt.' },
        model_id: { type: 'string', description: 'New model ID to assign, or "auto" for auto-routing. Call list_models for valid IDs. Omit to keep the current model.' },
        permissions: { type: 'object', description: 'Permission fields to MERGE (only include what changes): file_read/file_write ("*" or path array), exec_allow/exec_deny (command arrays), network_domains ("*"|"none"|array), can_spawn_agents, can_assign_permissions, system_control (array of "mouse"/"keyboard"/"screen"/"applescript"/"web_browse" or ["*"]).' },
        tools: { type: 'object', description: 'Tool-access policy to MERGE: { allow?: string[], deny?: string[] } of tool names.' },
        grants: {
          type: 'object',
          description: 'Access to MERGE, same shape as spawn_agent\'s grants. Only the sections you name change; everything else the agent holds is left alone, EXCEPT that tools.allow, if you send it, REPLACES the whole list. To give an agent more named tools without touching what it has, send tools.add (a list of names): it appends and never drops one. Call get_agent_profile first to see what it has now. YOU CAN ONLY GRANT WHAT YOU HOLD — anything beyond your own access is refused, named, and audited.',
          properties: {
            tools: { type: 'object', description: 'Tool access by category: {"categories": ["Web", ...]} or {"categories": "*"}. {"add": ["tool_name", ...]} appends named tools to its allow list (nothing dropped); {"allow": [...]} replaces that list.' },
            integrations: { type: 'object', description: 'Connected services: {"plaud": bool, "credentials": [...] or "*", "google"/"microsoft": {"agent": "none"|"read"|"full", "user": same}}.' },
            channels: { type: 'object', description: 'Reaching humans: {"master": bool, "imessage"/"sms"/"voice"/"email"/"teams": "none"|"owner"|"all"}. Only the primary agent may set master.' },
            techniques: { type: 'array', items: { type: 'string' }, description: 'Technique IDs this agent may run, or "*" for all published ones.' },
          },
        },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'get_agent_profile',
    description: 'Read another agent\'s current identity: name, system prompt, model, tools policy, permissions, classification, group, status, and parent. Use this to audit what a sub-agent is currently set up as, or to read the existing system prompt before calling update_agent (which fully REPLACES the prompt, without reading first you can\'t append). Read-only, no side effects.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent ID or name to read' },
      },
      required: ['agent_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
  // ── Group Tools ──
  {
    name: 'create_agent_group',
    description: 'Create a new group of sub-agents around a shared purpose (a team, a squad, a project crew). This is THE tool for making a new agent group, do NOT try to insert rows into the database. The group description is injected into every member agent\'s system prompt as shared context.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        description: { type: 'string', description: 'Group purpose and context' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'update_group',
    description: 'Change an agent group\'s name or description (the shared context all members see). This is THE tool for editing a group, do NOT try to delete and recreate it. Provide at least one of name or description. Description changes appear in every member agent\'s context on their next turn.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'The group ID to update' },
        name: { type: 'string', description: 'New group name. Omit to keep the current name.' },
        description: { type: 'string', description: 'New group purpose/description. Appears in every member agent\'s context. Omit to keep the current description.' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'assign_to_group',
    description: 'Add a sub-agent to a group, or remove a sub-agent from its current group. This is THE tool for moving agents between groups, do NOT try to update the database directly. Pass null as group_id to remove the agent from any group and leave it ungrouped.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to assign' },
        group_id: { type: 'string', description: 'Group ID to assign to, or null to remove the agent from its current group' },
      },
      required: ['agent_id', 'group_id'],
    },
    fields: {
      group_id: {
        requiredNotEnforced:
          'null is a legitimate value: it removes the agent from its group (the description says so); ' +
          'the handler judges group_id itself and keeps the same messages the generic boundary used ' +
          'for a missing, non-string or blank value',
      },
    },
  },
  // ── Agent & Group Visibility Tools ──
  {
    name: 'list_agents',
    description: 'List every active sub-agent, name, ID, status, classification, group. Default returns compact rows. For full detail (activity timestamps, dormant flags, last error snippets) on every result, pass verbose=true; for full detail on ONE agent, use get_agent_profile(agent_id).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        include_terminated: { type: 'boolean', description: 'Include terminated agents (default: false)' },
        verbose: { type: 'boolean', description: 'If true, include activity timestamps, dormant detection, and last-error snippets per agent. Default false (compact rows).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'list_models',
    description: 'List all enabled models with name, ID, provider, cost, capabilities (vision, tools, thinking), context window, and max output tokens. ALWAYS call this before spawn_agent if you need to choose a model, it shows which models support vision, tool use, extended thinking, and their cost/performance trade-offs.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 3000,
  },
  {
    name: 'delete_group',
    description: 'Delete an agent group (squad) entirely. This is THE tool for removing a group, do NOT try to update the database directly. By default, member agents are moved to ungrouped (not terminated). Pass terminate_members=true to also kill every member in the group as part of the cleanup.\n\nOWNERSHIP: the System group cannot be deleted, and asking for it changes nothing. The main agent may delete any other group. Any other agent can only delete squads it created; squads created by the user (from the dashboard) are dismissed only by the user.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'The group ID to delete' },
        terminate_members: { type: 'boolean', description: 'If true, also terminate all non-permanent member agents before deleting the group. Default: false.' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'list_groups',
    description: 'List every agent group with its name, ID, and member count. Default returns compact rows. For full detail (description per group) on every result, pass verbose=true; for full detail on ONE group (members, settings, timestamps), use get_group_detail(group_id).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'If true, include each group\'s description. Default false (compact rows).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'get_group_detail',
    description: 'Get full details on one agent group, name, description, member roster (with each member\'s id, name, classification, status), creation metadata. Use this to drill in after list_groups.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group ID or name (case-insensitive)' },
      },
      required: ['group_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  // ── Public file sharing ──
  {
    name: 'share_publicly',
    description: 'Publish a file (or a small directory of files) to a publicly-accessible URL and return that URL. Use this when the user wants to view or share something outside the DOJO, e.g. an HTML page another agent built, a PDF report, an image, a static website. The DOJO copies the source into ~/.dojo/out/<slug>/ and exposes it at /share/<slug>/<filename> (no auth). If the DOJO has a Cloudflare tunnel running, the URL works from anywhere on the internet; otherwise it falls back to localhost (only viewable on the same machine). Use the returned URL directly, do NOT try to construct one yourself.\n\nHTML asset handling: when sharing a single .html file, the engine automatically scans it for linked local assets (`<img src>`, `<link href>`, `<script src>`, `url(…)` in inline CSS) and copies each one into the share directory so the page renders correctly at the public URL. Refs starting with http(s)://, data:, etc. are left alone. The tool result reports how many assets were copied. For multi-file sites or when you need precise control, point source_path at the directory and pass entry_filename.\n\nExamples:\n  • Share a single HTML page (linked assets auto-copied): share_publicly({ source_path: "/Users/.../uploads/<agent-id>/report.html" })\n  • Share a directory site: share_publicly({ source_path: "/Users/.../uploads/<agent-id>/site/", entry_filename: "index.html" })\n  • Share an image: share_publicly({ source_path: "/Users/.../uploads/<agent-id>/chart.png" })',
    effects: [
      { kind: 'fs_read', from: 'args.source_path' },
      { kind: 'fs_write', from: 'derived:the public share directory ~/.dojo/out/<slug>' },
    ],
    nonEffects: {
      'entry_filename': 'names a file WITHIN args.source_path, which the fs_read above already resolves; it never names a path of its own',
    },
    input_schema: {
      type: 'object',
      properties: {
        source_path: {
          type: 'string',
          description: 'Absolute path to the file or directory to share. Must already exist on disk.',
        },
        entry_filename: {
          type: 'string',
          description: 'Optional. When sharing a directory, the filename inside it the URL should point to (e.g. "index.html"). If omitted, defaults to index.html when present, otherwise the directory root.',
        },
      },
      required: ['source_path'],
    },
  },
  // ── Show files to user ──
  {
    name: 'show_to_user',
    description: 'Display one or more IMAGES (and short audio/video clips) to the user IN THE CHAT as inline thumbnails, as part of your reply. Use this for a picture you want the user to actually look at right in the conversation, a slide PNG a sub-agent sent you, a Drive image you downloaded, a photo from your uploads folder. WITHOUT this tool, "take a look at this image" is a lie, the file is on disk but the user sees no thumbnail.\n\nDOCUMENTS GO IN THE CANVAS, NOT HERE. A PDF, Word/Excel/PowerPoint, Markdown, text, or code file passed to show_to_user is REJECTED, those render as a real formatted preview in the canvas. Canvas-renderable files auto-open the moment you write them (file_write, or creating a Word/Excel/PDF); use canvas_render({ path }) to (re)open one. Reserve show_to_user for images/media.\n\nThis tool inserts an assistant-role message into your chat with the files attached and your `caption` as the bubble text. The user sees: your caption + thumbnails. After calling, end your turn (or continue with more tool calls if needed).\n\nExample (forwarding a slide preview a sub-agent sent):\n  show_to_user({ file_paths: ["/Users/.../uploads/<your-agent-id>/draft_slide_preview.png"], caption: "Sub-agent finished a draft of the title slide. Looks good to me, anything you want changed?" })\n\nFile paths must already exist (typically under ~/.dojo/uploads/<your-agent-id>/ or wherever a sub-agent delivered them). Files outside the uploads dir are copied in.',
    // Files outside the uploads dir are copied in so the dashboard's serve
    // route finds them: the write is declared, and the scope is the CALLING
    // agent's own uploads dir, so no agent writes into another's.
    effects: [
      { kind: 'fs_read', from: 'args.file_paths[]' },
      { kind: 'fs_write', from: 'derived:the calling agent uploads directory', scope: { at: 'tree', template: '~/.dojo/uploads/<agentId>' } },
    ],
    input_schema: {
      type: 'object',
      properties: {
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to the files to display. Images render as thumbnails; PDFs render as document chips. Up to 10 files per call.',
        },
        caption: {
          type: 'string',
          description: 'Your message text accompanying the files. This becomes the bubble content (e.g., "Here\'s the slide, looks good?"). Keep it natural; this is your reply to the user.',
        },
      },
      required: ['file_paths'],
    },
  },
  // ── Channel Safe-Sender Management ──
  {
    name: 'add_safe_sender',
    description: 'Add a person to one of the channel safe-sender allowlists so the agent can auto-reply when they message back. **Call this ONLY when the user explicitly asks you to start a conversation with someone (e.g., "email <a contact> about Q4", "text <a contact> a heads-up", "start a Teams chat with <a contact>"). Do NOT call this preemptively, and do NOT call it because someone happened to email or text you without the user asking.**\n\nThe `user_request_quote` parameter is required and must contain the user\'s actual words asking for this. If you cannot quote a real user request, because no one asked, do NOT call this tool. The quote is audit-logged and reviewed by the user.\n\nThe allowlist controls AUTO-REPLY: once a person is on the channel\'s list, when they reply back (e.g., a Re: email or a Teams DM back), the engine routes the agent\'s response automatically. People NOT on the list can still send the agent messages; the agent just decides whether to surface them to the user instead of auto-replying.\n\nChannels:\n- `imessage`, iMessage contacts (no slot)\n- `gmail`, email senders, PER-SLOT (`agent` or `user`); the slot you add to must have "The agent may send as me" enabled on that account, or the call is refused\n- `outlook`, same as gmail, per-slot\n- `teams`, Teams DM senders (Entra accounts only, no slot)\n\nThe `slot` parameter is REQUIRED for `gmail` and `outlook` (decides which mailbox\'s list to add to) and IGNORED for `imessage` and `teams`. If the user doesn\'t specify the slot, infer from context: the agent\'s own account is the `agent` slot; the user\'s personal account is the `user` slot. If unsure, ask the user before calling.\n\nSharing levels:\n- `open_book`, no restrictions, treat like the owner (use for the owner\'s alternate addresses, household members the user trusts fully)\n- `dont_overshare`, default for new contacts; share what is asked, do not volunteer extra details\n- `cautious`, answer only what is asked, briefly, high-level only\n- `project_only`, discuss only the specific project named in description (description is required for this level)\n\nIf the user asks you to start a conversation with someone but does not specify a sharing level, default to `dont_overshare`.\n\nIdempotent: if the address is already on the target list, the call succeeds without modifying anything.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['imessage', 'gmail', 'outlook', 'teams'],
          description: 'Which channel\'s safe-sender list to add to.',
        },
        address: {
          type: 'string',
          description: 'For iMessage: phone number or email/Apple ID. For gmail/outlook: email address. For teams: email or UPN.',
        },
        slot: {
          type: 'string',
          enum: ['agent', 'user'],
          description: 'REQUIRED for gmail/outlook: which mailbox slot\'s safe-sender list to add to. `agent` = the agent\'s own account (the bot\'s mailbox). `user` = the user\'s personal account. The slot must have "The agent may send as me" enabled in Settings → Channels (the card for that account), or this call is refused. Ignored for imessage and teams.',
        },
        user_request_quote: {
          type: 'string',
          description: 'REQUIRED. Quote the user\'s actual words asking you to start this conversation or add this person. Pull verbatim from a recent user message in this thread, do not paraphrase, do not invent. If you cannot quote a real user request, do NOT call this tool. The quote is persisted to the audit log and the user can review it.',
        },
        name: {
          type: 'string',
          description: 'Display name for this contact (e.g., "<their full name>"). Optional but strongly recommended; defaults to the address if omitted.',
        },
        sharing_level: {
          type: 'string',
          enum: ['open_book', 'dont_overshare', 'cautious', 'project_only'],
          description: 'How much info the agent should share with this person. Defaults to "dont_overshare" if omitted.',
        },
        description: {
          type: 'string',
          description: 'Optional note about who this person is. Required when sharing_level=project_only, name the specific project.',
        },
        is_agent: {
          type: 'boolean',
          description: 'Set true ONLY when this contact is another AI agent / Dojo assistant (not a human). Lets the engine skip work-acks and damp content-free courtesy volleys on machine-to-machine iMessage threads. Defaults false. iMessage only.',
        },
      },
      required: ['channel', 'address', 'user_request_quote'],
    },
  },
  // ── iMessage Tools ──
  {
    name: 'imessage_list_contacts',
    reachesPeople: true,
    description: 'List ALL of YOUR iMessage contacts. The DOJO iMessage bridge is YOUR own iMessage account (not the user\'s phone) - these are the people YOU are authorized to text from your account. Call this whenever the user asks you to text, message, iMessage, or shoot a message to someone and you do not already know that person\'s address. Returns every contact with name, address, description (who they are), sharing_level, and whether they are the primary user. Pick the most likely match yourself based on the user\'s phrasing, your memory of who is who, and the description field. If two contacts plausibly fit (e.g. the user said "text <a first name>" and two contacts share it), ask the user to clarify before sending.',
    effects: [{ kind: 'proc', from: 'derived:iMessage bridge (osascript)' }],
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'imessage_send',
    reachesPeople: true,
    description: 'Send an iMessage from YOUR OWN iMessage account (the DOJO bridge). **As of v2.7.23, replies to inbound iMessages auto-route via the engine, you do NOT need to call this tool to reply. Just write your reply text; engine delivers it.**\n\n**DEFAULT-CHANNEL RULE, When the person you are talking to is on the dashboard, the default is "reply in dashboard." The [Turn context] block says who you are talking to and where your written reply goes.** Do NOT additionally text them on iMessage to "also share on their phone" or "make sure they see it." Their reply belongs in the dashboard they are looking at.\n\n**Exceptions where you SHOULD call imessage_send even though the user is in dashboard:**\n\n- **The user explicitly named iMessage in this turn\'s request.** e.g. "text me the meeting list," "iMessage me when that finishes," "send the summary to my phone." The user choosing the channel overrides the default-channel rule.\n- **A task you are working on explicitly specifies iMessage as the delivery channel.** Tasks frequently encode delivery preferences in their goal or notes ("when this completes, iMessage the owner with the result," "deliver via iMessage, not chat"). The task directive is the authoritative source for that work item; the default-channel rule is for the absence of a task directive, not in addition to it.\n- **The recipient is someone OTHER than the person this turn is talking to.** Texting the user\'s spouse, a colleague, a third-party contact on the safe-sender list, the default-channel rule is only about the person you are talking to.\n\n- **You judge that a text is warranted.** For example it is urgent, or the user may step away before reading the dashboard. The default-channel rule is a suggestion, not a block: the engine does not refuse a text to the owner, and the choice of channel is yours. One exception: while you are delivering a reminder, a text to anyone but the owner is refused once; repeat the exact same send if the owner really asked for it.\n\n**Beyond those exceptions, this tool is for:**\n\n- **PROACTIVE outreach** = the turn was NOT triggered by a user message at all. Examples: a scheduled task fires and you decide to text the user, a watchdog event needs surfacing while the user is offline, a long-running job you started yesterday completes and you let the user know.\n- **RICH actions** = sending with attachments (image, PDF, etc.). The text rides with the first file via the imsg CLI. Use only when an attachment is genuinely needed; sending a link as a "rich action" does not qualify.\n\nVOICE: write like an actual text message. No markdown, no headers, no bullet lists. Short and conversational.\n\nRecipient rule: ALWAYS pass `recipient`. A call with no recipient does not run; its result tells you who this turn is talking to and asks who the message is for. The value MUST exactly match a safe-sender address. If you only know the person by name (e.g. user said "text <contact-name>"), call `imessage_list_contacts` first to look up the address. Passing an unknown address is refused. For attachments, pass any local path (e.g. ~/.dojo/uploads/<agent-id>/photo.jpg).',
    effects: [
      { kind: 'send', from: 'args.recipient' },
      { kind: 'fs_read', from: 'args.attachments[]', leaves: true },
      { kind: 'proc', from: 'derived:iMessage bridge (osascript)' },
    ],
    input_schema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'Phone number or Apple ID of a configured safe sender. Required: who this message is for. It never defaults to the person this turn is talking to. Refused if not in the safe-sender allowlist.',
        },
        message: {
          type: 'string',
          description: 'The message text to send. May be empty string if you only want to send attachments.',
        },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of absolute local file paths to send as iMessage attachments (images, PDFs, etc.). The message text rides with the first file; additional files arrive as separate bubbles.',
        },
      },
      required: ['message', 'recipient'],
    },
  },
  {
    name: 'sms_send',
    reachesPeople: true,
    description: 'Send a text message via Twilio SMS. **Replies to inbound SMS auto-route via the engine - you do NOT need to call this tool to reply. Just write your reply text; the engine delivers it.**\n\n**DEFAULT-CHANNEL RULE - When the person you are talking to is on the dashboard, the default is "reply in dashboard." The [Turn context] block says who you are talking to and where your written reply goes.** Do NOT also text them via SMS to "make sure they see it."\n\n**Exceptions where you SHOULD call sms_send even when the user is in dashboard:**\n\n- **The user explicitly named SMS / text in this turn\'s request** (e.g. "text <a contact> that the meeting moved," "SMS me when that finishes").\n- **A task you are working on explicitly specifies SMS delivery.**\n- **The recipient is someone OTHER than the person this turn is talking to** (texting a family member, colleague, vendor contact on the safe-sender list).\n\n- **You judge that a text is warranted.** For example it is urgent, or the user may step away before reading the dashboard. The default-channel rule is a suggestion, not a block: the engine does not refuse a text to the owner, and the choice of channel is yours. One exception: while you are delivering a reminder, a text to anyone but the owner is refused once; repeat the exact same send if the owner really asked for it.\n\n**Beyond those, this tool is for:**\n\n- **PROACTIVE outreach** = the turn was NOT triggered by a user message at all (scheduled task, watchdog event, long-running job completion).\n\nVOICE: write like an actual text message. No markdown, no headers, no bullet lists. Short and conversational.\n\nRecipient rule: pass `to` as a phone number in E.164 format (e.g. `+15551234567`). The recipient MUST be on the Twilio SMS safe-sender allowlist - sending to an unknown number is refused. Per-number `from` argument is optional; defaults to the configured default Twilio number.\n\nLimits: 1600 character maximum per send (carrier limit). Personal Twilio accounts have throughput caps; high-volume sends may be deferred or rejected by Twilio.',
    effects: [{ kind: 'send', from: 'args.to' }],
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient phone number in E.164 format (+15551234567). Must be on the Twilio SMS safe-sender allowlist.',
        },
        body: {
          type: 'string',
          description: 'The text message body. Max 1600 characters.',
        },
        from: {
          type: 'string',
          description: 'Optional. Specific Twilio number to send from (must be one the owner has configured). Defaults to the configured default number.',
        },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'voice_call',
    reachesPeople: true,
    description: 'Place a phone call via Twilio. The agent (you) holds the call: the caller speaks, Twilio streams audio to the dojo, your STT transcribes, you generate a reply, your TTS speaks back over the same call. **Use sparingly**, voice calls are real-time, costly, and demand immediate attention. Prefer SMS or iMessage unless the user asked for a phone call or the situation needs it (urgent, complex back-and-forth, hands-free).\n\nThe recipient MUST be on the Twilio Voice safe-caller allowlist; sending to an unknown number is refused. Personal Twilio accounts only, no robocalls, no campaign sends. The active Cloudflare tunnel must be running so Twilio can connect the audio back to the dojo.\n\n**HOW THE CALL OPENS, IMPORTANT.** When you place an outbound call, the called party answers and speaks FIRST (usually "Hello?"). That is normal human phone etiquette. You wait, hear their hello, and THEN identify yourself and state your purpose on the very next turn (the dojo will give you a turn the moment they speak). **Do NOT pass `opening_message`** in the standard case, it gets spoken the instant the call connects, before they say anything, which makes you sound like a robocall. Leaving silence on the line until they say "Hello?" is the right move. Real people do this on every outbound call.\n\nThe `opening_message` arg is reserved for unusual cases where you really do need audio queued up at connect time, for example, when you know the recipient has asked you to leave a voicemail directly, or when answering machine detection has already resolved to "voicemail" and you are dropping a pre-composed message. In normal person-to-person calling, leave it blank.\n\n`purpose` is a short string describing why you are calling (e.g. "scheduling the Tuesday demo", "following up on the buyer meeting"). It is shown to you in the system prompt on each turn of the call so you can stay on track, and it shapes your opening self-ID once the callee says hello. Provide it for any outbound call with a specific reason.\n\nMax call duration is capped (Settings → Channels → Twilio). Calls exceeding the cap are hung up automatically.',
    effects: [{ kind: 'send', from: 'args.to' }],
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient phone number in E.164 format (+15551234567). Must be on the Voice safe-caller allowlist.',
        },
        opening_message: {
          type: 'string',
          description: 'OPTIONAL and usually OMITTED. Text spoken the instant the call connects, before the recipient says anything. In normal person-to-person calling this is wrong: the recipient says "Hello?" first and YOU respond after. Only set this when you specifically need pre-composed audio at connect time (known voicemail drop, etc.). Leave blank for standard calls.',
        },
        purpose: {
          type: 'string',
          description: 'Short, specific reason for the call (e.g. "scheduling the Tuesday demo", "following up on the buyer meeting"). Surfaced to you in the phone-mode system prompt on every turn so you stay on track, and used in your self-ID when the callee picks up. Strongly recommended on any outbound call with a defined goal.',
        },
        from: {
          type: 'string',
          description: 'Optional. Specific Twilio number to call from. Defaults to the configured default number.',
        },
      },
      required: ['to'],
    },
  },
  {
    name: 'voice_call_end',
    reachesPeople: true,
    description: 'Hang up an active phone call you initiated (or are participating in). Use after the conversation has reached a natural conclusion or when the call needs to be terminated (recipient ended verbally but didn\'t hang up, escalating off-topic, etc.). Returns whether the hang-up succeeded.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        call_id: {
          type: 'string',
          description: 'The Twilio Call SID returned from voice_call or shown in voice_call_status.',
        },
        reason: {
          type: 'string',
          description: 'Optional short reason string for the call log.',
        },
      },
      required: ['call_id'],
    },
  },
  {
    name: 'voice_call_status',
    reachesPeople: true,
    description: 'Check the status of an active phone call, or list all active calls when no call_id is given. Useful for orienting if you\'re unsure whether a call you placed is still active.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        call_id: {
          type: 'string',
          description: 'Optional. Specific Twilio Call SID to look up. Omit to list all active calls.',
        },
      },
      required: [],
    },
  },
  // ── Image Generation Tools ──
  {
    name: 'image_create',
    description: 'Generate an image from a text description. The engine delivers the image itself: 10-60 s later it posts the image alone, with no caption, and you are told it was delivered. The engine writes no acknowledgement or caption for you: you may say ONE short line of your own before you end your turn (if a person is waiting and you say nothing, the engine asks you to). You do NOT need a second turn; do not describe the image or announce it a second time. Do NOT mention the image generation model or any internal system to the user.',
    // The generator's bytes land in `~/.dojo/uploads/generated`, a SIBLING of
    // the calling agent's uploads dir, before anything is copied to the caller.
    // The delivery copy reads that directory and writes the caller's uploads
    // tree. Neither declaration adds a refusal.
    effects: [
      { kind: 'fs_write', from: 'derived:the calling agent uploads directory', scope: { at: 'tree', template: '~/.dojo/uploads/<agentId>' } },
      { kind: 'fs_write', from: 'derived:the generated-images directory the provider bytes land in', scope: { at: 'tree', template: '~/.dojo/uploads/generated' } },
      { kind: 'fs_read', from: 'derived:the generated image read back for the delivery copy', scope: { at: 'tree', template: '~/.dojo/uploads/generated' } },
    ],
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A detailed plain-English description of what you want the image to show. Include subject, setting, composition, mood, style, lighting, colors, and any specific details. The more specific you are, the better the result. Example: "A cozy coffee shop interior at sunset, warm golden light streaming through large windows, vintage leather chairs, exposed brick walls, steam rising from a latte on a wooden table in the foreground, cinematic lighting, photorealistic". Do NOT use image-model flags like "--ar 16:9", just describe what you want.',
        },
        title: {
          type: 'string',
          description: 'A short, descriptive title for the image, 2 to 6 words that summarize the subject. Used as the file name when the user downloads it. Examples: "coffee shop sunset", "golden retriever puppy", "fantasy castle at dusk". Plain words only, no extensions, no quotes, no special characters. Strongly recommended; if omitted, the file name will fall back to a generic id.',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
          description: 'Aspect ratio. 1:1 square, 16:9 landscape, 9:16 portrait/vertical, 4:3 standard, 3:4 portrait standard. Defaults to 1:1 if omitted.',
        },
        style_hint: {
          type: 'string',
          description: 'Optional style override like "photorealistic", "illustration", "watercolor", "3D render", "pixel art", "line drawing". If omitted, the image model picks the best style for the description.',
        },
      },
      required: ['description'],
    },
  },
  // ── Audio Transcription Tool ──
  {
    name: 'transcribe_audio',
    description: 'Convert speech in an audio file to text. Pass ONE of: attachment_id (the fileId from a recent chat attachment, preferred when the user just shared the file), path (an absolute local path inside ~/.dojo/uploads/), or url (https only). Common input formats: mp3, wav, m4a, opus, webm, ogg, aac. Returns the transcribed text inline (no new attachment is created). The platform posts a short acknowledgment automatically; you do not need to announce that you are transcribing.',
    // `attachment_id` names its file INDIRECTLY, so `via` declares the
    // indirection and the gate loop resolves it with the handler's own reader;
    // a stale id resolves to nothing, grants nothing. Every source is
    // transcoded through ffmpeg, whose argv is a temp pair no scope names.
    effects: [
      { kind: 'fs_read', from: 'args.attachment_id', via: 'attachment_row' },
      { kind: 'fs_read', from: 'args.path' },
      { kind: 'net', from: 'args.url' },
      { kind: 'proc', from: 'derived:ffmpeg, to decode or demux the source into 16 kHz mono PCM WAV', scope: { at: 'program', program: 'ffmpeg' } },
    ],
    input_schema: {
      type: 'object',
      properties: {
        attachment_id: {
          type: 'string',
          description: 'The fileId of an audio attachment from a recent chat message. Preferred when the user just shared a file in chat (the file pointer was surfaced to you as `[Audio attached: ..., fileId: ...]`).',
        },
        path: {
          type: 'string',
          description: 'Absolute local path to an audio file. The main agent may name any audio file on the Mac; any other agent, a file inside ~/.dojo/uploads/. Use this only when you have a path but no fileId.',
        },
        url: {
          type: 'string',
          description: 'An https URL pointing directly at an audio file. Use this when the user gave you a link. Max 50 MB; non-https URLs are rejected.',
        },
        language: {
          type: 'string',
          description: 'Optional 2-letter ISO language hint (e.g. "en", "es", "ja"). Improves accuracy on non-English audio. If omitted, the engine auto-detects.',
        },
      },
      required: [],
    },
  },
  // ── Text-to-Speech Tool ──
  {
    name: 'tts_create',
    description: 'Generate spoken audio from text, text-to-speech (TTS). The engine handles delivery, DO NOT write any user-facing text around this tool. When you call it, the engine posts a short acknowledgment immediately. ~2-10 s later the engine delivers the audio file directly to the chat with an inline player. Just call this tool and end your turn. Do NOT mention the TTS model or any internal system to the user. This tool reads text aloud verbatim, it does NOT compose music or sound effects.',
    // The audio bytes land in the shared generated-assets directory, are read
    // back, and are copied into the caller's uploads dir: all three legs declared.
    effects: [
      { kind: 'fs_write', from: 'derived:the generated-assets directory the provider bytes land in', scope: { at: 'tree', template: '~/.dojo/uploads/generated' } },
      { kind: 'fs_read', from: 'derived:the generated asset read back for the delivery copy', scope: { at: 'tree', template: '~/.dojo/uploads/generated' } },
      { kind: 'fs_write', from: 'derived:the calling agent uploads directory', scope: { at: 'tree', template: '~/.dojo/uploads/<agentId>' } },
    ],
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to read aloud. Plain prose. The engine will speak it verbatim, so write what you want the user to HEAR, no stage directions, no bracketed asides. Punctuation guides pacing.',
        },
        voice: {
          type: 'string',
          description: 'Optional voice id. The valid ids depend on the configured TTS model and are listed in this tool description under VOICES (with each voice\'s character) when known. Pick the closest match to what the user asked for. If omitted, the model uses its default. Pass only when the user requested a specific voice or the conversation established one.',
        },
        title: {
          type: 'string',
          description: 'A short, descriptive title for the audio, 2 to 6 words that summarize what was said. Used as the file name when the user downloads it. Examples: "weekly recap", "rude grocery joke", "good morning". Plain words only, no extensions, no quotes, no special characters. Strongly recommended; if omitted, the file name falls back to a generic id.',
        },
      },
      required: ['text'],
    },
  },
  // ── Music Generation Tool ──
  {
    name: 'music_create',
    description: 'Compose original music or a sound piece from a text description. This is NOT text-to-speech (use tts_create to read words aloud). music_create generates an instrumental/musical composition from a creative brief. The engine handles the ENTIRE flow: when you call it, the engine posts a brief acknowledgment to the user and returns immediately. ~10-40 s later when the track is ready, the engine posts the audio file directly to the chat with an inline player. You do NOT get a second turn, just call this tool once and end your turn. Do NOT call it again to check progress. Do NOT mention the music model or any internal system to the user.',
    // The track bytes land in the shared generated-assets directory, are read
    // back, and are copied into the caller's uploads dir: all three legs declared.
    effects: [
      { kind: 'fs_write', from: 'derived:the generated-assets directory the provider bytes land in', scope: { at: 'tree', template: '~/.dojo/uploads/generated' } },
      { kind: 'fs_read', from: 'derived:the generated asset read back for the delivery copy', scope: { at: 'tree', template: '~/.dojo/uploads/generated' } },
      { kind: 'fs_write', from: 'derived:the calling agent uploads directory', scope: { at: 'tree', template: '~/.dojo/uploads/<agentId>' } },
    ],
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A detailed plain-English description of the music: genre, mood, instrumentation, tempo, structure, and any reference style. Example: "An upbeat lo-fi hip-hop beat with a mellow Rhodes piano, soft vinyl crackle, a relaxed boom-bap drum groove around 85 BPM, and a warm sub bass. Chill and nostalgic." The more specific, the better. Do NOT include lyrics unless you want them sung.',
        },
        title: {
          type: 'string',
          description: 'A short, descriptive title, 2 to 6 words summarizing the track. Used as the file name when the user downloads it. Examples: "lofi study beat", "epic battle theme". Plain words only, no extensions or special characters. Strongly recommended; if omitted, the file name falls back to a generic id.',
        },
      },
      required: ['description'],
    },
  },
  // ── Video Generation Tool ──
  {
    name: 'video_create',
    description: 'Generate a short video from a text description. Video generation is SLOW, it runs asynchronously in the background and usually takes 1 to 10 minutes. The engine handles the ENTIRE flow: when you call this tool it posts a brief acknowledgment to the user ("I\'ve started the video, I\'ll send it when it\'s ready") and returns immediately. When the video finishes, the engine posts it directly to the chat with an inline player, you do NOT get a second turn and you do NOT need to write anything. Just call this tool once and end your turn. Do NOT call it again to check progress, the user can watch progress via the indicator next to the chat input. Do NOT mention the video model or any internal system to the user.',
    effects: [{ kind: 'fs_write', from: 'derived:the calling agent uploads directory' }],
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A detailed plain-English description of the video: subject, action, setting, camera movement, mood, lighting, style. Example: "A golden retriever puppy running across a sunlit meadow in slow motion, camera tracking alongside, warm afternoon light, shallow depth of field, cinematic". The more specific, the better. Do NOT use model flags like "--ar 16:9".',
        },
        title: {
          type: 'string',
          description: 'A short, descriptive title, 2 to 6 words summarizing the clip. Used as the file name when the user downloads it. Examples: "puppy in meadow", "city timelapse". Plain words only, no extensions or special characters. Strongly recommended.',
        },
        duration_seconds: {
          type: 'number',
          description: 'REQUIRED. Clip length in seconds. If the user named a length (e.g. "a 2 second clip"), pass that exact number here, do NOT bury it in the description. Different models accept different lengths; if your value is out of range the engine tells you the valid options so you can re-pick. Keep it short unless the user asks for longer (longer = costlier and slower).',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['16:9', '9:16', '1:1'],
          description: 'REQUIRED. Frame shape. 16:9 landscape, 9:16 vertical/portrait (good for phones / social), 1:1 square. Pick what suits the request; default to 16:9 if unspecified.',
        },
        resolution: {
          type: 'string',
          enum: ['480p', '720p', '1080p'],
          description: 'REQUIRED. Output resolution. Higher is sharper but costlier and slower. Default to 720p if the user did not specify. Not every model supports every resolution; the engine tells you the valid options if yours is unsupported.',
        },
        ref_image_attachment_id: {
          type: 'string',
          description: 'Optional. The fileId of an image attachment to use as the first frame / reference for the video. Use when the user wants the video to start from or match a specific image they shared.',
        },
      },
      required: ['description', 'duration_seconds', 'aspect_ratio', 'resolution'],
    },
  },
  // ── System Control Tools ──
  {
    name: 'mouse_click',
    description: 'Move the mouse to coordinates and click. Use after screen_screenshot to identify target positions.',
    effects: [{ kind: 'proc', from: 'derived:cliclick' }],
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate (pixels from left)' },
        y: { type: 'number', description: 'Y coordinate (pixels from top)' },
        click_type: { type: 'string', enum: ['left', 'right', 'double'], description: 'Click type (default: left)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_move',
    description: 'Move the mouse without clicking. Useful for hovering to reveal tooltips or menus.',
    effects: [{ kind: 'proc', from: 'derived:cliclick' }],
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'keyboard_type',
    description: 'Type text or press key combinations. Use for filling forms, entering commands, or keyboard shortcuts.',
    effects: [{ kind: 'proc', from: 'derived:cliclick' }],
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        key_combo: { type: 'string', description: 'Special key combination: cmd+c, cmd+v, cmd+tab, cmd+shift+3, return, escape, tab, delete, arrow-up, arrow-down, arrow-left, arrow-right' },
      },
      required: [],
    },
  },
  {
    name: 'screen_screenshot',
    description: 'Take a screenshot and describe what is visible using a vision model, this is for YOU to perceive the screen (then act, e.g. before mouse_click to find targets). Returns a text description with approximate coordinates for interactive elements. Pass `query` to focus the description on what you\'re looking for (recommended).\n\nIMPORTANT, do NOT use this to "show the user the screen." If the user wants to SEE your live screen, watch what you are doing, or take control of this Mac remotely (common when they\'re away and need to click/approve something here), use `screen_broadcast` instead, it opens a live, interactive viewer in their canvas. screen_screenshot only gives YOU a still snapshot; it shows the user nothing.',
    effects: [
      { kind: 'proc', from: 'derived:screencapture' },
      { kind: 'fs_write', from: 'derived:the screenshot temp directory' },
    ],
    input_schema: {
      type: 'object',
      properties: {
        region: {
          type: 'object',
          description: 'Capture a specific region instead of full screen',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        query: { type: 'string', description: 'Specific question about the screen, e.g., "where is the Submit button?". Strongly recommended, without it the description is generic and longer.' },
      },
      required: [],
    },
    concurrency: 'special',
    maxResultTokens: 2000,
  },
  {
    name: 'applescript_run',
    description: 'Run an AppleScript command. Use for macOS automation: opening apps, controlling windows, running Shortcuts, interacting with system features.',
    effects: [{ kind: 'applescript', from: 'args.script' }],
    input_schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The AppleScript code to execute' },
      },
      required: ['script'],
    },
    concurrency: 'serial',
    maxResultTokens: 4000,
  },
  // ── Headless Browser Tool ──
  {
    name: 'web_browse',
    description:
      'Open a headless browser to interact with web pages. Can navigate, take screenshots, click elements, fill forms, and extract content. Use for pages that require JavaScript rendering or interaction. The browser session persists across calls, navigate first, then interact.\n\nFor the `extract` action, ALWAYS pass a `goal` describing what you\'re looking for, the tool returns a focused extract (~1-2K tokens) instead of the raw page (often 30K+).',
    effects: [{ kind: 'net', from: 'args.url' }],
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'screenshot', 'click', 'type', 'scroll', 'extract', 'close'],
          description: 'The browser action to perform',
        },
        url: { type: 'string', description: 'URL to navigate to (for "navigate" action)' },
        selector: { type: 'string', description: 'CSS selector for click/type targets' },
        text: { type: 'string', description: 'Text to type (for "type" action)' },
        scroll_direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        scroll_amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
        goal: {
          type: 'string',
          description:
            'For the `extract` action: what to extract from the page. Be specific. The tool will return a focused summary, not the raw page. Example: "the article headline and first paragraph", "all link URLs in the navigation menu", "the form fields and their current values".',
        },
      },
      required: ['action'],
    },
    concurrency: 'special',
    maxResultTokens: 3000,
  },
  // ── Technique Tools ──
  {
    name: 'save_technique',
    description: '**TRAINER AGENT AND MAIN AGENT ONLY.** Save a reusable technique to the dojo. Other agents calling this get refused with a redirect to the trainer.\n\nThe trainer owns the library because techniques are SHAREABLE: when one user exports a technique to another user, every support file, dependency, and external resource has to travel with it. A technique whose TECHNIQUE.md references `~/Documents/random.py` (a file an agent dropped somewhere arbitrary) is broken on every other machine. Keeping creation with the trainer and the main agent is what keeps techniques portable by construction.\n\nWhen you (as another sub-agent) want a technique built, send the trainer a message describing what you want, with the contents of any custom files inline. They\'ll create the technique correctly.\n\n**File-reference validation runs at save time.** Every path TECHNIQUE.md references must EITHER exist inside the technique\'s support directory (pass it in `files`) OR be declared in `dependencies` as a repo / asset / manual step that the importing trainer will fetch. References that don\'t resolve cause a structured refusal.\n\n**Drafts vs publish:** techniques save as DRAFT by default. Drafts can\'t be loaded with `use_technique`. Pass publish=true whenever the user expects it usable right away.',
    effects: [
      { kind: 'fs_write', from: 'args.files[].path' },
      { kind: 'net', from: 'args.dependencies.repos[].url' },
      { kind: 'fs_write', from: 'args.dependencies.repos[].install_to' },
      { kind: 'net', from: 'args.dependencies.models_or_assets[].url' },
      { kind: 'fs_write', from: 'args.dependencies.models_or_assets[].destination' },
    ],
    nonEffects: {
      'dependencies.language_packages[].install_in': 'a package-manager working directory recorded in the manifest for the importing trainer to act on later; this call writes nothing there',
    },
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name (lowercase, hyphens ok, used as directory name)' },
        display_name: { type: 'string', description: 'Human-readable name' },
        description: { type: 'string', description: 'One-line description of what this technique does' },
        instructions: { type: 'string', description: 'Full TECHNIQUE.md content, detailed step-by-step instructions for how to execute this technique, written for other agents to follow. Every file path referenced here must either exist in `files` or be declared in `dependencies`.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path within the technique directory (e.g. "server.py", "templates/brief.md")' },
              content: { type: 'string', description: 'File content' },
            },
          },
          description: 'Supporting files to include in the technique directory. Every custom script, template, config, or data file the technique needs MUST be passed here, files referenced in TECHNIQUE.md that aren\'t included and aren\'t in dependencies will refuse the save.',
        },
        dependencies: {
          type: 'object',
          description: 'External dependencies that aren\'t support files. The importing trainer reads this to set up the technique on the receiving machine. Omit if the technique has none.',
          properties: {
            system_packages: { type: 'array', description: 'OS-level packages (brew, apt, etc.).', items: { type: 'object', properties: { manager: { type: 'string', description: 'e.g. "brew", "apt", "choco"' }, package: { type: 'string' }, version: { type: 'string' }, note: { type: 'string' } }, required: ['manager', 'package'] } },
            language_packages: { type: 'array', description: 'Language-runtime packages (npm, pip, gem, etc.).', items: { type: 'object', properties: { manager: { type: 'string', description: 'e.g. "npm", "pip"' }, package: { type: 'string' }, version: { type: 'string' }, install_in: { type: 'string' }, note: { type: 'string' } }, required: ['manager', 'package'] } },
            repos: { type: 'array', description: 'Git repos to clone.', items: { type: 'object', properties: { url: { type: 'string' }, ref: { type: 'string' }, install_to: { type: 'string', description: 'Relative path inside technique dir to clone into' }, note: { type: 'string' } }, required: ['url'] } },
            models_or_assets: { type: 'array', description: 'Files to download (model weights, datasets, binaries).', items: { type: 'object', properties: { url: { type: 'string' }, destination: { type: 'string', description: 'Relative path inside technique dir to save to' }, sha256: { type: 'string' }, note: { type: 'string' } }, required: ['url', 'destination'] } },
            manual_steps: { type: 'array', items: { type: 'string' }, description: 'Free-text steps the importing trainer must walk the user through (signups, hardware setup, etc.).' },
          },
        },
        publish: { type: 'boolean', description: 'TRUE = save and publish immediately so other agents can use_technique it. FALSE (default) = save as draft, only usable after a separate publish_technique call. Pass TRUE whenever the user expects the technique to be usable now.' },
      },
      required: ['name', 'display_name', 'description', 'instructions'],
    },
    fields: {
      display_name: {
        requiredNotEnforced:
          'executeSaveTechnique refuses with one message naming all four fields at once ' +
          '("name, display_name, description, and instructions are all required."), which the per-field message would split',
      },
    },
  },
  {
    name: 'use_technique',
    description: 'Activate and load a technique. Prefer technique_read for browsing/searching, use_technique now returns an outline (sections + supporting files + sizes), and you call technique_read action="section" to read specific parts. Big techniques no longer truncate.\n\nWhen you load a technique, apply its actual steps rather than skipping back to cached memory.',
    effects: [{ kind: 'fs_read', from: 'derived:the technique directory named by args.name' }],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID (the short name) to load' },
      },
      required: ['name'],
    },
  },
  {
    name: 'technique_read',
    description: 'Read a technique with surgical precision instead of slurping the whole thing. Five actions: (1) outline [default], returns headings, line ranges, char counts, and supporting files; never truncates; ALWAYS your first call when consulting a technique. (2) section, read one section by section_name="<title>" (case-insensitive substring match) or lines="start-end"; oversize sections require explicit line ranges. (3) search, query="<term>" greps TECHNIQUE.md AND all supporting files, returns matches with file + line number + surrounding context; best path through a huge technique. (4) list_files, list the technique\'s supporting files. (5) read_file, read one supporting file by file="<path>", optional lines="start-end".\n\nWhen you read a technique, apply what it says rather than falling back to cached memory (agents used to read techniques and then ignore them). Pattern: technique_read (one or more times to load what you need), then do the work.',
    effects: [{ kind: 'fs_read', from: 'args.name', via: 'technique_dir', scope: { at: 'argTree' } }],
    nonEffects: {
      file: 'a RELATIVE path INSIDE the technique directory — the handler refuses an absolute path or a traversal at the site before it opens anything. Resolved as a path of its own it would name a file relative to the server working directory, which this tool never touches; the real read is covered by the technique-tree effect above',
    },
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID, slug, or display name.' },
        action: { type: 'string', enum: ['outline', 'section', 'search', 'list_files', 'read_file'], description: 'Which read to perform. Default: outline.' },
        section_name: { type: 'string', description: 'For action="section": the heading title (case-insensitive substring match, e.g. "Stage 1" matches "## Stage 1, Brief").' },
        lines: { type: 'string', description: 'For action="section" or action="read_file": line range like "100-200" (inclusive, 1-indexed).' },
        query: { type: 'string', description: 'For action="search": text to find (case-insensitive substring).' },
        include_files: { type: 'boolean', description: 'For action="search": include supporting files in the search. Default true.' },
        file: { type: 'string', description: 'For action="read_file": relative path inside the technique directory (e.g. "templates/brief.md").' },
      },
      required: ['name'],
    },
    concurrency: 'safe',
  },
  {
    name: 'list_techniques',
    description: 'List available techniques. Default returns compact rows (name + id + tags + state). For descriptions and usage counts on every result, pass verbose=true; for the full instructions of ONE technique, use use_technique(name).',
    effects: [{ kind: 'fs_read', from: 'derived:the techniques directory' }],
    input_schema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Filter by tag' },
        include_drafts: { type: 'boolean', description: 'Include draft techniques (Sensei only)' },
        verbose: { type: 'boolean', description: 'If true, include description and usage count per technique. Default false (compact rows).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'publish_technique',
    description: 'Publish a draft technique, making it available to all agents. **Trainer agent and main agent only**, other callers get refused with a redirect.',
    effects: [{ kind: 'fs_write', from: 'derived:the technique directory named by args.name' }],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID to publish' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_technique',
    description: 'Update a technique\'s display name, description, instructions, files, or dependency manifest. Instruction changes create a version snapshot; metadata-only changes (display_name / description / dependencies) do not. **Trainer agent and main agent only**, other callers get refused with a redirect.\n\nFile-reference validation runs the same way as save_technique: if `instructions` references a path that isn\'t in the support dir AND isn\'t declared in dependencies, the update is refused.',
    effects: [
      { kind: 'fs_write', from: 'args.name', via: 'technique_dir', scope: { at: 'argTree' } },
      { kind: 'net', from: 'args.dependencies.repos[].url' },
      { kind: 'fs_write', from: 'args.dependencies.repos[].install_to' },
      { kind: 'net', from: 'args.dependencies.models_or_assets[].url' },
      { kind: 'fs_write', from: 'args.dependencies.models_or_assets[].destination' },
    ],
    nonEffects: {
      'files[].path': 'a RELATIVE path INSIDE the technique directory, joined onto the technique row\'s recorded `directory_path` before anything is written. Resolved as a path of its own it named a file relative to the server working directory, which this tool never touches, while the real write went undeclared; the real write is covered by the technique-tree effect above',
      'dependencies.language_packages[].install_in': 'a package-manager working directory recorded in the manifest for the importing trainer to act on later; this call writes nothing there',
    },
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID (slug) to update, NOT the new display name. Use display_name to rename.' },
        display_name: { type: 'string', description: 'New human-readable name shown in the UI. Slug/ID does not change.' },
        description: { type: 'string', description: 'New description text.' },
        instructions: { type: 'string', description: 'Updated TECHNIQUE.md content. Bumps the version. Validated against the technique\'s support files + dependency manifest.' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }, description: 'Files to add or update inside the technique directory.' },
        dependencies: {
          type: 'object',
          description: 'Replace the technique\'s dependency manifest. Pass the FULL manifest (read the existing one first with technique_read action="read_file" file="dependencies.json" if you only want to add an entry, this overwrites).',
          properties: {
            system_packages: { type: 'array', items: { type: 'object', properties: { manager: { type: 'string' }, package: { type: 'string' }, version: { type: 'string' }, note: { type: 'string' } }, required: ['manager', 'package'] } },
            language_packages: { type: 'array', items: { type: 'object', properties: { manager: { type: 'string' }, package: { type: 'string' }, version: { type: 'string' }, install_in: { type: 'string' }, note: { type: 'string' } }, required: ['manager', 'package'] } },
            repos: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, ref: { type: 'string' }, install_to: { type: 'string' }, note: { type: 'string' } }, required: ['url'] } },
            models_or_assets: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, destination: { type: 'string' }, sha256: { type: 'string' }, note: { type: 'string' } }, required: ['url', 'destination'] } },
            manual_steps: { type: 'array', items: { type: 'string' } },
          },
        },
        change_summary: { type: 'string', description: 'Brief description of what changed.' },
      },
      required: ['name', 'change_summary'],
    },
    fields: {
      change_summary: {
        requiredNotEnforced:
          'executeUpdateTechnique DEFAULTS it (`args.change_summary as string || "Updated by agent"`), so an update ' +
          'without one succeeds today — enforcing it here would be a new refusal that removes a working call',
      },
    },
  },
  {
    name: 'submit_technique_for_review',
    description: 'Mark a draft technique as ready for Sensei review.',
    effects: [{ kind: 'fs_write', from: 'derived:the technique directory named by args.name' }],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID to submit for review' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_technique',
    description: 'Permanently delete a technique and all its files. **Trainer agent and main agent only**, other callers get refused with a redirect. Only use when the user explicitly asks to delete. Cannot be undone.',
    effects: [{ kind: 'fs_delete', from: 'derived:the technique directory named by args.name' }],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID (slug) to delete' },
      },
      required: ['name'],
    },
  },
  {
    name: 'technique_list_versions',
    description: 'List the on-disk version history of a technique. Returns each version\'s number, change summary, who made it, when, and the absolute file path you can `file_read` to inspect the prior content. Use this when you (the Trainer) need to look at how a technique evolved or restore a prior version. The current TECHNIQUE.md is always the latest version; older versions live in <technique-dir>/versions/TECHNIQUE_v{N}.md.',
    effects: [{ kind: 'fs_read', from: 'derived:the technique version directory named by args.name' }],
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Technique ID (slug) to list versions for' },
      },
      required: ['name'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'technique_set_placeholder',
    description: 'Fill in a {{NEEDS_FROM_USER:LABEL}} placeholder across an imported technique\'s files with a value the user provided. Use this during the setup conversation that follows a technique import: read the IMPORT_MANIFEST.json + README.md in the technique\'s directory, ask the user for each placeholder one at a time, then call this tool with the answer. After every placeholder is filled, call technique_finalize.',
    // Reads the staged manifest and every file the placeholder appears in before
    // substituting; the technique dir resolves through the handler's own reader.
    effects: [
      { kind: 'fs_read', from: 'args.technique', via: 'technique_dir', scope: { at: 'argTree' } },
      { kind: 'fs_write', from: 'args.technique', via: 'technique_dir', scope: { at: 'argTree' } },
    ],
    fields: {
      'value': { secret: true },
    },
    input_schema: {
      type: 'object',
      properties: {
        technique: { type: 'string', description: 'Technique ID (slug) being set up' },
        label: { type: 'string', description: 'Placeholder label (UPPER_SNAKE_CASE), must match one listed in the manifest' },
        value: { type: 'string', description: 'The actual value (API key, token, URL, etc.) the user provided' },
      },
      required: ['technique', 'label', 'value'],
    },
  },
  {
    name: 'technique_finalize',
    description: 'Finalize an imported technique once every placeholder has been filled in. Removes the staged IMPORT_MANIFEST.json and flips the technique\'s state from needs_setup → draft so it can be published. Only valid after every technique_set_placeholder call has been made; will refuse if any markers remain.',
    // Reads the technique's files to confirm no placeholder remains, then
    // DELETES the staged IMPORT_MANIFEST.json; the state flip is a database
    // update, so the tree is the tightest scope that fits a resolved directory.
    effects: [
      { kind: 'fs_read', from: 'args.technique', via: 'technique_dir', scope: { at: 'argTree' } },
      { kind: 'fs_delete', from: 'args.technique', via: 'technique_dir', scope: { at: 'argTree' } },
    ],
    input_schema: {
      type: 'object',
      properties: {
        technique: { type: 'string', description: 'Technique ID (slug) to finalize' },
      },
      required: ['technique'],
    },
  },

  // ── Vault (Long-Term Memory) ──

  {
    name: 'vault_remember',
    description: 'Save an important piece of knowledge to the dojo\'s long-term memory vault. Saved immediately and visible to all agents.\n\n**NEVER store credentials, API keys, tokens, passwords, secrets, or any other authentication material in the vault.** Those go in `credential_add`, they live in a separate encrypted store that never decays, never appears in vault_search or Dreamer summaries, and is read on-demand at API-call time via `credential_get`. The engine will refuse vault entries that look like credentials.\n\nWHEN THE USER EXPLICITLY ASKS YOU TO REMEMBER SOMETHING, phrases like "remember that…", "I want you to remember…", "always do X", "never do Y", "from now on, …", "make sure you always…", call this tool with `verbatim: true` and `pin: true`. Pass the user\'s instruction word-for-word in `content`. Do NOT paraphrase or compress; the user\'s exact wording is the point.\n\nFor everything else (facts you observed, decisions made, preferences inferred), write a tight summary and let the DOJO handle filler-stripping.\n\nExample (user-explicit): vault_remember({ content: "Always confirm with the user before pushing to main.", type: "preference", verbatim: true, pin: true }).\nExample (observed): vault_remember({ content: "Tunnel: Cloudflare named.", type: "fact" }).\n\nWhen a fact came from a URL, a file, or a document, pass its location in source_ref (and source_page / source_section when you know them) so you can cite it and re-open the original later. Example (with source): vault_remember({ content: "Cardiologist cleared patient for surgery.", type: "fact", source_ref: "doctor-report-2026.pdf", source_page: 3 }).',
    effects: [],
    nonEffects: {
      'source_ref': 'RULING (T1): a polymorphic locator — a URL or a file/document reference — STORED as provenance on the vault entry, never dereferenced by the platform. Declares no effect today; a future reader that fetches it declares the effect here',
    },
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The knowledge to remember. Write a tight summary unless verbatim=true, in which case pass the user\'s exact words.' },
        type: { type: 'string', enum: ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'], description: 'Type of knowledge' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        pin: { type: 'boolean', description: 'If true, this memory is always included in context regardless of relevance. Set true when the user explicitly tells you to remember something.' },
        permanent: { type: 'boolean', description: 'If true, this fact never decays over time (use for definitionally stable truths like names, relationships, birth dates).' },
        verbatim: { type: 'boolean', description: 'If true, the DOJO preserves your content exactly, no bloat-phrase stripping, no date prefix, no compression. Use when capturing the user\'s explicit memory instruction word-for-word ("remember that…", "always X", "never Y", "from now on…").' },
        distinct: { type: 'boolean', description: 'Set true ONLY after a near-duplicate bounce, when the new fact is genuinely DIFFERENT from the existing entry it resembles (not a correction of it). This tells the engine to save it as a separate entry even though it reads similar. If instead your new fact corrects or replaces the existing one, do NOT set distinct, call vault_update(entry_id=…) on that entry.' },
        source_ref: { type: 'string', description: 'Optional. Where this fact came from: a URL (https://...) or a file / document path (e.g. "doctor-report-2026.pdf"). Pass it whenever the fact was read from a specific source, so it can be cited and reopened later. Does not count against entry length.' },
        source_page: { type: 'number', description: 'Optional. Page number within source_ref, when the fact came from a specific page of a document (e.g. 3).' },
        source_section: { type: 'string', description: 'Optional. Section or heading within source_ref, when known (e.g. "Assessment").' },
      },
      required: ['content', 'type'],
    },
    fields: {
      type: {
        requiredNotEnforced:
          'executeVaultRemember refuses a missing type by NAMING the seven valid kinds (fact, preference, decision, ' +
          'procedure, relationship, event, note) — the generic message would send the model guessing',
      },
    },
  },
  {
    name: 'vault_search',
    description: 'Search the dojo\'s long-term memory vault. Two modes: `semantic` (default) uses embedding similarity, great for conceptual recall like "what does the user prefer about commit messages?". `exact` does substring matching on entry content, use when you need to find a literal string, e.g. debugging memory poisoning, finding entries that mention a specific name/phrase/typo verbatim, or auditing what got saved. Semantic search is blind to exact spelling (a query for "corp erp" returns concepts about email domains, not the literal string), so reach for `exact` whenever the question is "is this specific text anywhere in my memory?". Use vault_get(entry_id) for full content of a match, vault_update to fix incorrect entries in place, vault_forget to mark obsolete.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        mode: { type: 'string', enum: ['semantic', 'exact'], description: 'semantic (default): embedding similarity. exact: substring LIKE match on content.' },
        type: { type: 'string', enum: ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'], description: 'Filter by memory type (optional)' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'vault_get',
    description: 'Get the full content of a specific vault entry by ID. Pairs with vault_search, search returns short snippets; expand returns the full entry when you need details.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'Vault entry ID (from vault_search results)' },
      },
      required: ['entry_id'],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
  {
    name: 'vault_refresh',
    description:
      'Re-load the session-start vault snapshot mid-conversation: pinned entries + entries tagged `session_context`. Use when the long-term memory has changed (you or the user just added/edited an important entry) and you want it reflected immediately without waiting for the next session reset. Returns the freshly-loaded entries as a snapshot.',
    effects: [],
    // `session_context` is a vault TAG value this tool selects on, not a
    // parameter the caller passes.
    advertisedNotDeclared: {
      session_context: 'a vault entry TAG this tool selects on, not a parameter',
    },
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 4000,
  },
  {
    name: 'vault_forget',
    description: 'Mark a vault entry as obsolete. Use when information is no longer accurate or relevant. The entry is soft-deleted, not destroyed. Sensei agents only.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'The vault entry ID to mark as obsolete' },
        reason: { type: 'string', description: 'Why this is no longer accurate' },
      },
      required: ['entry_id', 'reason'],
    },
    fields: {
      reason: {
        requiredNotEnforced:
          'executeVaultForget refuses a missing reason with what the reason is FOR ("explain why this is no longer ' +
          'accurate") — the audit value of the field is in that sentence',
      },
    },
  },
  {
    name: 'vault_update',
    description: 'Replace the content of an existing vault entry in place. Use this instead of vault_forget + vault_remember when you need to CORRECT an entry, the existing entry ID stays stable, embedding gets regenerated, and there is no window where two contradictory versions co-exist. Common case: an entry contains a factual error, an outdated fact, or a self-defeating "DON\'T do X" warning that is now reinforcing the bad behavior. Rewrite it as the positive correct form. Required `reason` is logged for audit.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'The vault entry ID to update (from vault_search results)' },
        new_content: { type: 'string', description: 'The replacement content. Should be the corrected fact stated positively, do not include the wrong form as a "don\'t" reminder, because future you will re-read it and get poisoned again.' },
        reason: { type: 'string', description: 'Brief audit note: what changed and why (e.g., "corrected misspelling that was causing the agent to reproduce the typo").' },
      },
      required: ['entry_id', 'new_content', 'reason'],
    },
  },
  {
    name: 'vault_discard_archives',
    description: 'Permanently delete one or more conversation archives from vault_conversations WITHOUT extracting any vault entries from them. Use when the conversations are junk (test runs, error spam, repetitive nonsense, ephemeral chatter) that does not need to be remembered. Unlike complete_task on a Dreamer batch (which marks archives as processed because real work was done), this tool throws the archives away unread. Returns the number of archives actually deleted. For the Dreamer and the main agent only.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        archive_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Archive IDs to discard. Get IDs from your cycle message\'s "Full archive list" or from the batch text.',
        },
        reason: {
          type: 'string',
          description: 'Brief explanation for the audit log (e.g., "test conversation, no meaningful content").',
        },
      },
      required: ['archive_ids', 'reason'],
    },
  },

  {
    name: 'lesson_record',
    description: 'Record ONE lesson from a rough task listed in your ROUGH TASKS batch. A lesson is a cue (the situation that should bring it to mind), the lesson in one sentence, the ids of that task\'s own timeline events that show it, and a confidence from 0 to 1, for what a technique should have covered. It is kept for 90 days; a lesson with a cue we already hold renews instead of duplicating. Not a vault entry: never use vault_remember for these. Refuses an event id that is not in the task\'s timeline. For the Dreamer and the main agent only.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The rough task\'s id, exactly as shown in the batch.' },
        cue: { type: 'string', description: 'The situation that should bring this lesson to mind, in the task\'s own terms.' },
        lesson: { type: 'string', description: 'One sentence: what to do differently next time.' },
        evidence_event_ids: { type: 'array', items: { type: 'number' }, description: 'Event ids (the #numbers in the task\'s timeline) that show it. At least one; each must be in that task\'s timeline.' },
        confidence: { type: 'number', description: 'From 0 to 1.' },
      },
      required: ['task_id', 'cue', 'lesson', 'evidence_event_ids', 'confidence'],
    },
  },

  // ── DOJO Contacts ──
  // DOJO-native person records, separate from Microsoft/Google contact
  // directories. Agents write to this store as they learn about people
  // the owner interacts with; the owner can read and edit through the
  // dashboard's Vault → Contacts tab.
  {
    name: 'contact_remember',
    description: 'Record or update a contact in the DOJO contacts store. Upserts: if any provided email/phone/imessage handle (or display_name) matches an existing record, the new fields APPEND to that record - emails/phones/handles/tags merge with dedup; notes get timestamped and appended. If no match, a new contact is created (display_name required in that case). Use this whenever you learn something about a person the owner interacts with: "introduced by <another contact> 2026-06-05", "prefers iMessage over email", "works at <their employer> as the buyer", a new email address, etc. Different from vault_remember because contacts is structured person-as-entity storage; use vault_remember for general facts and decisions that aren\'t about a specific person.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Existing contact ID (full or 8-char prefix). Optional - if omitted, the tool matches on email/phone/imessage/display_name.' },
        display_name: { type: 'string', description: 'Full name. Required when creating a new contact.' },
        preferred_name: { type: 'string', description: 'Nickname / short form / what the owner actually calls them.' },
        emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses. Merge-appended on existing records.' },
        phones: { type: 'array', items: { type: 'string' }, description: 'Phone numbers. Merge-appended on existing records.' },
        imessage_handles: { type: 'array', items: { type: 'string' }, description: 'iMessage handles (typically a phone or Apple ID email). Merge-appended on existing records.' },
        company: { type: 'string', description: 'Organization / company.' },
        role: { type: 'string', description: 'Title or relationship label ("buyer", "neighbor", "agent\'s contact at vendor X").' },
        notes: { type: 'string', description: 'Freeform observation. On an existing record this is appended with a timestamp; on a new record it is the initial notes body.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short tags like "family", "client", "vendor", "personal". Merge-appended on existing records.' },
      },
      required: [],
    },
  },
  {
    name: 'contact_search',
    description: 'Search the DOJO contacts store by partial match across name, preferred_name, company, role, emails, phones, imessage_handles, tags, and notes. Returns a compact one-line-per-contact list; call contact_get for the full record. Empty query returns the most recently updated contacts.',
    effects: [],
    fields: { query: { allowEmpty: true } },
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term. Matched case-insensitively across all searchable fields.' },
        limit: { type: 'number', description: 'Maximum results (default 20, capped at 200).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'contact_list',
    description: 'List contacts in the DOJO store. Sort options: "updated" (default, newest activity first), "name" (display_name A-Z), "company". Useful for browsing rather than targeted lookup; for lookup prefer contact_search.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        sort_by: { type: 'string', enum: ['updated', 'name', 'company'], description: 'Sort key. Default "updated".' },
        limit: { type: 'number', description: 'Page size (default 50).' },
        offset: { type: 'number', description: 'Skip this many records (for pagination).' },
      },
      required: [],
    },
  },
  {
    name: 'contact_get',
    description: 'Fetch a single contact\'s full record: all addresses, tags, notes, and provenance. Pass the contact_id from contact_search or contact_list (full UUID or 8-char prefix).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Contact ID (full or 8-char prefix).' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'contact_update',
    description: 'Explicit field-level edit of a contact, distinct from the upsert-semantics of contact_remember. Pass mode="replace" (default) to overwrite list fields and notes with the new values, or mode="append" to merge into the existing values (same merge semantics as contact_remember).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Contact ID (full or 8-char prefix).' },
        display_name: { type: 'string' },
        preferred_name: { type: 'string' },
        emails: { type: 'array', items: { type: 'string' } },
        phones: { type: 'array', items: { type: 'string' } },
        imessage_handles: { type: 'array', items: { type: 'string' } },
        company: { type: 'string' },
        role: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'Default "replace". Use "append" when adding to existing lists/notes without losing what was there.' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'contact_forget',
    description: 'Delete a contact from the DOJO store. Irreversible. Use only when the owner has explicitly asked to drop a contact, or for cleanup of a record you mistakenly created.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Contact ID (full or 8-char prefix).' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'contacts_overview',
    description: 'Quick orientation: how many contacts the DOJO has on file, the top tags, and the top companies. Cheap, no args.',
    effects: [],
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ── Squad Coordination ──
  // Shared memory for agents in the same group_id. Faster than A2A messages
  // for handing structured context between squad members.
  {
    name: 'squad_share',
    description: 'Write a piece of knowledge into your squad\'s shared memory so other members can recall it. Squad-scoped (only visible to agents in the same group_id). Use for handoffs, coordination notes, shared findings, things teammates need that don\'t belong in your personal vault. Example: squad_share({ content: "Customer prefers phone calls before 5pm PT.", tags: ["customer", "comms"] }).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The shared knowledge.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering on recall.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'squad_recall',
    description: 'Search your squad\'s shared memory for relevant entries written by you or other members. Returns short snippets, call vault_get(entry_id) for full content if needed. Example: squad_recall({ query: "customer comms" }).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for. Pass an empty string to list recent entries regardless of content.' },
        tag: { type: 'string', description: 'Filter to entries with this tag (optional).' },
        limit: { type: 'number', description: 'Max results (default 5).' },
        group_id: { type: 'string', description: 'Optional: read this squad instead of your own (one you created; the main agent may read any).' },
      },
      required: [],
    },
    concurrency: 'safe',
    maxResultTokens: 2000,
  },
  {
    name: 'dreamer_run_now',
    description: 'THE tool for running a dream cycle on demand. Do NOT send_to_agent the Dreamer to ask it to dream, the Dreamer agent is reactive, not self-starting; only this tool kicks the actual extraction pipeline (process unprocessed conversation archives → extract memories into the vault → write a dream_reports row). Use whenever the user says "run the dreamer", "process my recent conversations", "consolidate memories", "wind things down", or anything similar. The cycle runs in the background and takes 30s–3min. Returns whether the cycle started + the Dreamer agent ID. Primary agent only.',
    effects: [],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'serial',
    maxResultTokens: 1000,
  },
  {
    name: 'cost_summary',
    description: 'Get a quick spend report: today\'s total cost across all agents and the top 3 spenders by agent and by model. Use this when the user asks "what has the DOJO cost today" or similar. Primary agent only.',
    effects: [],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'channel_inspect',
    description: 'Snapshot of every communication channel you have active right now: which mailboxes you monitor, which you can send from, which the owner uses personally, iMessage/Teams reachability, safe-sender counts, account types. Call this when you need to answer "what mailbox should I send from?" or "do I have access to <channel>?" or when the per-turn [Channel landscape] block from a non-dashboard trigger isn\'t enough detail. Cheap, no args. On dashboard turns the landscape block is omitted to save tokens, so this is the way to look up the same info on demand.',
    effects: [],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  dojoInspectDefinition,
  {
    name: 'open_settings',
    description: 'Open the dashboard Settings panel to a specific tab (and optionally scroll to a section) on the user\'s screen. Use when the user asks where a setting lives or asks you to take them to it ("where do I change my voice?", "open my channel settings", "take me to where I add a provider"). This only moves the UI for a user who has the dashboard open; it changes no settings on its own. Pick the tab that holds what they asked about: platform (shown as the Dojo tab: capacity, Ollama, system model, remote access, web search, migration, restart), providers (LLM provider API keys), models (enable models, pricing, and the image/video/TTS/music/vision/transcription model pickers), router (model routing + test), profile (your name, about-you), security (dashboard password), sensei (dreamer + healer schedules), channels (iMessage, Twilio/SMS, Google + Microsoft accounts), integrations (Plaud), voice (TTS/STT voice, speed, wake word), update (version + software update). Optionally pass `section` as the heading of the specific card to scroll to (e.g. "Hands-free wake word", "Playback speed", "Twilio", "Remote Access"), it best-effort matches a section title within the tab. To actually CHANGE a capability model yourself, prefer set_capability_model; use this when the user wants to see/change it themselves.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        tab: {
          type: 'string',
          enum: ['platform', 'providers', 'models', 'router', 'profile', 'security', 'sensei', 'channels', 'integrations', 'voice', 'update'],
          description: 'Which settings tab to open.',
        },
        section: {
          type: 'string',
          description: 'Optional. The heading of the specific section/card to scroll to within the tab (e.g. "Hands-free wake word", "Twilio", "Web Search Provider"). Best-effort match against the section titles on that tab.',
        },
      },
      required: ['tab'],
    },
    concurrency: 'safe',
    maxResultTokens: 300,
  },
  {
    name: 'dashboard_navigate',
    description: 'Navigate the user\'s dashboard to a top-level page. Use when the user asks you to take them somewhere ("show me the Ledger", "open the tracker", "pull up my agents"). Only moves the UI for a user who has the dashboard open; changes nothing on its own. For the Settings page use open_settings instead. Pages: chat (main conversation), agents (agent roster), techniques (saved workflows), tracker (tasks + projects), memory (the Vault: memories), costs (the Ledger: spend), health (Vitals: system health).',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          enum: ['chat', 'agents', 'techniques', 'tracker', 'memory', 'costs', 'health'],
          description: 'Which page to open.',
        },
      },
      required: ['page'],
    },
    concurrency: 'safe',
    maxResultTokens: 300,
  },
  {
    name: 'set_capability_model',
    description: 'Change which model the DOJO uses for a media/perception capability, on the user\'s behalf ("use Flux for image generation", "switch the video model to Veo", "use the on-device whisper for transcription"). Do this yourself with this tool when asked, don\'t tell the user to go change it in Settings. The model must already be added and enabled in Settings → Models and actually have that capability, if it isn\'t, this changes nothing and returns the list of valid models so you can pick correctly. Capabilities: image (the image_create tool), video (video_create), tts (tts_create / spoken audio), music (music_create), vision (the fallback model that reads images + screenshots), transcription (speech-to-text; also accepts local:whisper or local:moonshine for the on-device engines). NOTE: this is only for the platform capability models, to change the PRIMARY agent\'s own chat model, use update_agent instead.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          enum: ['image', 'video', 'tts', 'music', 'vision', 'transcription'],
          description: 'Which capability\'s model to set.',
        },
        model_id: {
          type: 'string',
          description: 'The model id to use (must be enabled and have the capability). For transcription you may also pass local:whisper or local:moonshine. Use list_models to find the right id if unsure.',
        },
      },
      required: ['capability', 'model_id'],
    },
    concurrency: 'serial',
    maxResultTokens: 1500,
  },
  {
    name: 'check_for_update',
    description: 'Check whether a newer version of the DOJO platform is available, comparing the installed version against the latest release ON THE USER\'S SELECTED UPDATE CHANNEL. The dojo has two channels (set in Settings → Update): "Stable" (normal releases, the default) and "Preflight" (pre-release/test builds, versioned like 3.1.8-preflight.2). This tool reports whichever the user is on, the result states the channel, so relay it: never present a Preflight build as a normal stable release. Read-only: reports the installed version, the latest version, whether an update is available, the release notes (what changed), the channel, and when the check was last run. Reads a snapshot the engine refreshes once a day, so it answers instantly without hitting the network (the timestamp tells you how fresh it is). Use when the user asks "is there an update?", "am I on the latest version?", "what\'s in the new version?", or as a precursor to apply_update so you can tell them what they\'d be getting. If the user has set up a recurring task to check for updates, this is the tool that task calls.',
    effects: [{ kind: 'net', from: 'fixed:the GitHub release feed for the selected channel' }],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'safe',
    maxResultTokens: 1500,
  },
  {
    name: 'apply_update',
    description: 'Download and install the latest DOJO platform update FROM THE USER\'S SELECTED CHANNEL (Stable or Preflight, see check_for_update), then restart the server. If the user is on Preflight this installs a pre-release/test build; if they ask to update but you suspect they want a normal release, confirm the channel first. Do this ONLY when the user explicitly asks you to update ("update the dojo", "install the new version", "go ahead and update"). The DOJO will be briefly unavailable while it restarts (a few seconds under normal supervision), so let the user know it\'s restarting. Only works on production installs, not a dev server. If already up to date it just says so. Prefer calling check_for_update first so you can confirm what\'s changing.',
    effects: [
      { kind: 'net', from: 'fixed:the release archive of the selected channel' },
      { kind: 'proc', from: 'derived:unzip, rsync and npm install over the running install' },
      { kind: 'fs_write', from: 'derived:the running install directory' },
    ],
    input_schema: { type: 'object', properties: {}, required: [] },
    concurrency: 'serial',
    maxResultTokens: 1000,
  },
  {
    name: 'set_voice',
    description: 'Change the voice you speak with and/or its playback speed, on the user\'s behalf ("use the Bella voice", "switch to a British voice", "slow your voice down", "talk a bit faster"). Do this yourself with this tool when asked, don\'t tell the user to change it in Settings. The voice name is matched against the on-device Kokoro voices (built-in + any the user imported) first, then the Hume cloud library if cloud voice is set up; if nothing matches it returns some valid voice names instead of changing anything. Speed is 0.5–2 where 1 is normal. Provide a voice, a speed, or both. Changes take effect the next time voice mode starts.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        voice: {
          type: 'string',
          description: 'A voice name or id (e.g. "Bella", "am_michael"). Matched against on-device then cloud voices.',
        },
        speed: {
          type: 'number',
          description: 'Playback speed, 0.5–2 (1 = normal). Optional.',
        },
      },
      required: [],
    },
    concurrency: 'serial',
    maxResultTokens: 1000,
  },
  {
    name: 'set_channel',
    description: 'Turn a communication channel on or off on the user\'s behalf ("turn on the iMessage bridge", "disable SMS", "enable Twilio voice calls"). This is something you DO for the user with this tool, do NOT tell them to go flip it in the dashboard themselves; that is exactly what this tool is for. Channels: imessage (the iMessage bridge, needs a bridge recipient already configured in Settings → Channels), twilio (the Twilio integration master switch, needs Twilio credentials configured), sms (Twilio text messaging), voice_calls (Twilio phone calls). If a prerequisite is missing it tells you what to set up first rather than half-enabling a broken channel. To add someone to a channel\'s allowed-sender list, use add_safe_sender instead.',
    effects: [],
    input_schema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['imessage', 'twilio', 'sms', 'voice_calls'],
          description: 'Which channel to toggle.',
        },
        enabled: {
          type: 'boolean',
          description: 'true to enable, false to disable.',
        },
      },
      required: ['channel', 'enabled'],
    },
    concurrency: 'serial',
    maxResultTokens: 1000,
  },
  {
    name: 'dojo_report',
    description: 'THE USER WANTS THE PEOPLE WHO BUILD THE DOJO TO KNOW ABOUT A PROBLEM WITH THE DOJO ITSELF — that is what this tool is for, and it is the only tool that does it. You gather the evidence, you write the problem up in your own words, and it lands on the user\'s dashboard as an issue they can post to the Dojo\'s public issue tracker. Every agent holds it by default.\n\nREACH FOR IT WHEN THE USER\'S WORDS POINT AT TELLING THE MAKERS. People say that a hundred different ways, so what follows is EXAMPLES, NOT A PATTERN TO MATCH: "that wasn\'t right, why did that happen, let\'s get this fixed in the Dojo" · "can we let DOJO know about this?" · "can we get that fixed?" · "report this problem" · "tell the Dojo devs" · "can we report this" · "submit a bug" · "let them know this is broken" · "file an issue" · "this is a platform problem". The list does not end there and is not meant to: if the SENSE of what they said is that the people who build this platform should know about this, this is the tool. Do not wait for a particular phrase, and do not require the word "bug".\n\nTHIS IS ABOUT THE PLATFORM, NOT ABOUT YOUR SITUATION. In scope: the engine, the tools, the dashboard, how a turn went, your own machinery misbehaving. THE WRONG BRANCHES, every one of which burns the turn: investigating your own grants or permissions; asking whether you need a permission for this; delegating to another agent or asking a peer for help; retrying the thing that just failed; fixing the user\'s immediate situation instead of reporting it. When the user\'s words point at REPORTING, none of those is the answer and this tool is — you already hold it, so there is nothing to request and nobody to ask.\n\nIF YOU ARE NOT SURE THAT IS WHAT THEY MEANT, ASK — ONE SHORT LINE, THEN ACT: "Do you want me to file this as a problem report to the Dojo\'s developers?" Asking costs one sentence. Guessing silently costs the whole turn, in either direction: a problem that never gets reported, or a write-up nobody asked for. Ask once, take the answer, act on it — and do not ask at all when their words already say it plainly.\n\nThree calls: `gather` gives you the evidence for a bounded recent window (at most 20 turns / 120 minutes); `draft` takes your write-up; `submit` shows it to the user for approval.\n\nYOU CANNOT SEND ANYTHING. `submit` puts a preview card in front of the user with your exact text; only the user pressing Post on that card can publish it, and only they can edit it. Say so when you tell them you have filed it.\n\nWHAT YOUR BRIEF MAY CONTAIN: your own abstracted description of the failure. WHAT IT MAY NOT CONTAIN, because this becomes a PUBLIC page: quotes from the conversation, anything the user wrote, anyone\'s name or address, file contents, file paths, or credentials. Describe the SHAPE ("a tool call was refused by a permission gate the engine had just told me to use"), never the content. A separate machine-built attachment carries the timings, token counts and tool names — you do not write it and cannot add to it.\n\nPick `lane` from the fixed list: tool-error (a tool refused or broke), wrong-answer (the platform answered, incorrectly), silence (nothing came back), permission (a gate refused something it should have allowed), other.',
    effects: [{ kind: 'fs_write', from: 'fixed:the local report bundle under ~/.dojo/reports' }],
    input_schema: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          enum: ['gather', 'draft', 'submit'],
          description: 'Which step you are on. Call them in this order.',
        },
        turns: { type: 'number', description: 'gather only. How many recent turns to look at. Capped at 20.' },
        minutes: { type: 'number', description: 'gather only. How far back in minutes. Capped at 120.' },
        report_id: { type: 'string', description: 'draft and submit. The id `gather` gave you.' },
        lane: {
          type: 'string',
          enum: ['tool-error', 'wrong-answer', 'silence', 'permission', 'other'],
          description: 'draft only. The failure lane, from the fixed list.',
        },
        title: { type: 'string', description: 'draft only. One line, under 80 characters, no user content.' },
        what_happened: { type: 'string', description: 'draft only.' },
        what_should_have_happened: { type: 'string', description: 'draft only.' },
        why_it_went_wrong: { type: 'string', description: 'draft only. Your reasoning about the cause.' },
        fix_ideas: { type: 'string', description: 'draft only. What you think would fix it.' },
      },
      required: ['phase'],
    },
    concurrency: 'serial',
    maxResultTokens: 12000,
  },
];

// Module-load registration of per-tool concurrency and maxResultTokens for the concurrency classifier;
// a tool omitting `concurrency` runs one call at a time.
import { registerConcurrency, registerMaxResultTokens } from '../v2/classifiers/concurrency.js';
for (const def of toolDefinitions) {
  if (def.concurrency) registerConcurrency(def.name, def.concurrency);
  if (def.maxResultTokens) registerMaxResultTokens(def.name, def.maxResultTokens);
}
