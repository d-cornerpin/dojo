import { useState } from 'react';

// ── Tool Call Card (assistant used a tool) ──

interface ToolCallCardProps {
  name: string;
  input: Record<string, unknown>;
}

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
  tracker_create_project: '\u{1F4CB}',
  tracker_create_task: '\u{1F4CB}',
  tracker_update_status: '\u{1F4CB}',
};

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
    case 'tracker_create_project':
      return String(input.title ?? '');
    case 'tracker_create_task':
      return String(input.title ?? '');
    case 'tracker_update_status':
      return `${String(input.task_id ?? '').slice(0, 8)} → ${input.status ?? ''}`;
    default:
      return Object.keys(input).slice(0, 3).join(', ');
  }
}

export const ToolCallCard = ({ name, input }: ToolCallCardProps) => {
  const [showRaw, setShowRaw] = useState(false);
  const icon = toolIcons[name] ?? 'T';
  const summary = toolSummary(name, input);

  return (
    <div className="my-1.5 rounded-lg border white/[0.08] bg-white/[0.04]/60 overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/[0.05]/40 transition-colors"
        onClick={() => setShowRaw(!showRaw)}
      >
        <span className="w-6 h-6 rounded bg-white/[0.08] text-blue-400 text-xs font-mono flex items-center justify-center shrink-0">
          {icon}
        </span>
        <span className="text-xs font-semibold white/70">{name}</span>
        <span className="text-xs white/40 truncate flex-1 font-mono">
          {summary}
        </span>
        <span className="text-xs white/30 shrink-0">{showRaw ? '-' : '+'}</span>
      </div>
      {showRaw && (
        <pre className="px-3 py-2 text-xs white/55 font-mono border-t white/[0.08]/50 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
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
          ? 'border-red-500/30 bg-red-500/5'
          : 'border-green-500/20 bg-green-500/5'
      }`}
    >
      <div className="px-3 py-1 flex items-center gap-1.5">
        <span className={`text-xs font-medium ${isError ? 'text-red-400' : 'text-green-400'}`}>
          {isError ? 'error' : 'result'}
        </span>
      </div>
      <pre
        className={`px-3 pb-2 text-xs font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto ${
          isError ? 'text-red-300/80' : 'white/55'
        }`}
      >
        {displayContent}
      </pre>
      {content.length > TRUNCATE_LENGTH && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-3 py-1 text-xs white/40 hover:white/70 border-t white/[0.08]/30 transition-colors"
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
