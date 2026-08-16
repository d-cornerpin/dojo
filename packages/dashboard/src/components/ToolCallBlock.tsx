import { useState } from 'react';
import { classifyTool } from '@dojo/shared';
import { deriveChipLabel } from '../lib/tool-display';

// ── Tool Call Card (assistant used a tool) ──

interface ToolCallCardProps {
  name: string;
  input: Record<string, unknown>;
}

// COSMETIC: specific per-tool glyphs for the tools worth a distinct icon. This
// is intentionally NOT exhaustive, iconFor() below falls back to a bucket icon
// derived from the canonical classifyTool class, so a brand-new tool always gets
// a sensible glyph (effectful/retrieval/etc.) instead of a bare "T". Drift here
// only dulls an icon; it can never make a tool render wrong.
const toolIcons: Record<string, string> = {
  exec: '>_',
  file_read: 'R',
  file_write: 'W',
  file_list: 'D',
  use_technique: '\u{1F94B}',
  save_technique: '\u{1F94B}',
  list_techniques: '\u{1F94B}',
  publish_technique: '\u{1F94B}',
  update_technique: '\u{1F94B}',
  web_search: '\u{1F50D}',
  web_fetch: '\u{1F310}',
  spawn_agent: '\u{1F916}',
  kill_agent: '\u{274C}',
  send_to_agent: '\u{1F4E8}',
  broadcast_to_group: '\u{1F4E2}',
  // PHASE-2 T8V: three tracker names became one verb, so one clipboard entry
  // covers every open/update/note/close.
  work_open: '\u{1F4CB}',
  work_update: '\u{1F4CB}',
  work_note: '\u{1F4CB}',
};

// Bucket-icon fallback keyed off the canonical display class, so an unlisted
// tool still gets a meaningful glyph rather than a generic placeholder.
const CLASS_ICONS: Record<ReturnType<typeof classifyTool>, string> = {
  'effectful-action': '\u{2699}', // gear: it did something in the world
  retrieval: '\u{1F50D}',         // magnifier: it read/searched
  delivery: '\u{1F4E4}',          // outbox: it showed the user something
  bookkeeping: '\u{2022}',        // dot: internal machinery
};

// UX-REPAIR T54(d): the bucket fallback reads the call's arguments, like every other
// client site, so a reminder gets the effectful gear rather than the bookkeeping dot.
function iconFor(name: string, input: Record<string, unknown>): string {
  return toolIcons[name] ?? CLASS_ICONS[classifyTool(name, input)];
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'exec':
      return String(input.command ?? '');
    case 'file_read':
    case 'file_write':
    case 'file_list':
      return String(input.path ?? '');
    case 'use_technique':
      return String(input.name ?? '');
    case 'save_technique':
      return String(input.display_name ?? input.name ?? '');
    case 'publish_technique':
    case 'update_technique':
      return String(input.name ?? '');
    case 'list_techniques':
      return input.tag ? `tag: ${input.tag}` : 'all';
    case 'web_search':
      return String(input.query ?? '');
    case 'web_fetch':
      return String(input.url ?? '');
    case 'spawn_agent':
      return String(input.name ?? '');
    case 'send_to_agent':
      return String(input.agent ?? input.agent_id ?? '').slice(0, 20);
    case 'broadcast_to_group':
      return `group: ${String(input.group_id ?? '').slice(0, 12)}`;
    // PHASE-2 T8V: one verb, several operations, so the summary reads the
    // discriminator instead of the name.
    case 'work_open':
      return String(input.title ?? input.what ?? input.description ?? '');
    case 'work_update':
      return input.status
        ? `${String(input.task_id ?? input.project_id ?? '').slice(0, 8)} → ${input.status}`
        : `${String(input.action ?? 'list')} ${String(input.task_id ?? input.project_id ?? '').slice(0, 8)}`.trim();
    case 'work_note':
      return String(input.task_id ?? '').slice(0, 8);
    default:
      return Object.keys(input).slice(0, 3).join(', ');
  }
}

export const ToolCallCard = ({ name, input }: ToolCallCardProps) => {
  const [showRaw, setShowRaw] = useState(false);
  const icon = iconFor(name, input);
  const summary = toolSummary(name, input);
  // Same payload-derived headline the regular-mode pill chips use (exec -> the
  // base command, applescript_run -> the app), so both display modes agree.
  // The raw tool name stays one click away in the expanded JSON.
  const headline = deriveChipLabel(name, input);

  return (
    <div className="my-1.5 rounded-lg border border-ui/[0.10] bg-ui/[0.05]/60 overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-ui/[0.05]/40 transition-colors"
        onClick={() => setShowRaw(!showRaw)}
      >
        <span className="w-6 h-6 rounded bg-ui/[0.08] text-cp-blue text-xs font-mono flex items-center justify-center shrink-0">
          {icon}
        </span>
        <span className="text-xs font-semibold text-ui/70">{headline}</span>
        <span className="text-xs text-ui/40 truncate flex-1 font-mono">
          {summary}
        </span>
        <span className="text-xs text-ui/25 shrink-0">{showRaw ? '-' : '+'}</span>
      </div>
      {showRaw && (
        <pre className="px-3 py-2 text-xs text-ui/55 font-mono border-t border-ui/[0.10]/50 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
};

// ── Tool Result Block (result from a tool execution) ──

interface ToolResultBlockProps {
  toolUseId: string;
  content: string;
  isError: boolean;
}

const TRUNCATE_LENGTH = 600;

export const ToolResultBlock = ({ content, isError }: ToolResultBlockProps) => {
  const [expanded, setExpanded] = useState(false);
  const isTruncated = content.length > TRUNCATE_LENGTH && !expanded;
  const displayContent = isTruncated ? content.slice(0, TRUNCATE_LENGTH) : content;

  return (
    <div
      className={`my-1.5 rounded-lg border overflow-hidden ${
        isError
          ? 'border-cp-coral/30 bg-cp-coral/5'
          : 'border-cp-teal/20 bg-cp-teal/5'
      }`}
    >
      <div className="px-3 py-1 flex items-center gap-1.5">
        <span className={`text-xs font-medium ${isError ? 'text-cp-coral' : 'text-cp-teal'}`}>
          {isError ? 'error' : 'result'}
        </span>
      </div>
      <pre
        className={`px-3 pb-2 text-xs font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto ${
          isError ? 'text-cp-coral/80' : 'text-ui/55'
        }`}
      >
        {displayContent}
      </pre>
      {content.length > TRUNCATE_LENGTH && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-3 py-1 text-xs text-ui/40 hover:text-ui/70 border-t border-ui/[0.10]/30 transition-colors"
        >
          {expanded ? 'Show less' : `Show all (${content.length} chars)`}
        </button>
      )}
    </div>
  );
};

// ── Legacy ToolCallBlock (for live WS events during streaming) ──

interface ToolCallBlockProps {
  toolName: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export const ToolCallBlock = ({ toolName, args, result, isError }: ToolCallBlockProps) => {
  return (
    <div>
      {args && <ToolCallCard name={toolName} input={args} />}
      {result !== undefined && (
        <ToolResultBlock toolUseId="" content={result} isError={!!isError} />
      )}
    </div>
  );
};
