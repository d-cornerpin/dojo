// The text-based tool-call fallback for models that print a tool call as text instead of
// using the structured mechanism. A call is taken ONLY when its name is a tool this very call
// offered; a JSON or tag example inside an ordinary answer (a package.json, a quoted
// `<tool_call>` tag) is the answer, and stays in the reply untouched.
import type { ToolCall } from '@dojo/shared';
import { createLogger } from '../logger.js';

const logger = createLogger('text-tool-fallback');

const TRIGGERS = ['<invoke name="', '<tool_call>', '<|tool_call>', '<function_call'];
const FENCED = /```json\s*(\{[\s\S]*?\})\s*```/g;

/** The one rule for both text-call paths: a call is taken only when its name was offered on this call. */
export function isOfferedTool(offered: ReadonlySet<string>, name: string): boolean {
  if (offered.has(name)) return true;
  logger.debug('Text tool call skipped: not a tool this call offered', { tool: name });
  return false;
}

export function extractTextToolCalls(
  fullText: string,
  offeredNames: Iterable<string>,
): { toolCalls: ToolCall[]; cleanText: string } {
  const offered = new Set(offeredNames);
  const toolCalls: ToolCall[] = [];
  if (offered.size === 0
    || !(TRIGGERS.some(t => fullText.includes(t)) || /```json\s*\{\s*"name"\s*:/.test(fullText))) {
    return { toolCalls, cleanText: fullText };
  }
  const pushIfOffered = (name: string, args: Record<string, unknown>): void => {
    if (!isOfferedTool(offered, name)) return;
    toolCalls.push({ id: `text_tool_${Date.now()}_${toolCalls.length}`, name, arguments: args });
  };

  // Pattern 1: <invoke name="tool"><parameter name="key">value</parameter></invoke>
  const invokeRegex = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  let match;
  while ((match = invokeRegex.exec(fullText)) !== null) {
    const args: Record<string, unknown> = {};
    const paramRegex = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(match[2])) !== null) {
      const val = paramMatch[2].trim();
      try { args[paramMatch[1]] = JSON.parse(val); } catch { args[paramMatch[1]] = val; }
    }
    pushIfOffered(match[1], args);
  }
  // Pattern 2: <tool_call><name>tool</name><arguments>{...}</arguments></tool_call>
  if (toolCalls.length === 0) {
    const tcRegex = /<tool_call>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/g;
    let tcMatch;
    while ((tcMatch = tcRegex.exec(fullText)) !== null) {
      let tcArgs: Record<string, unknown> = {};
      try { tcArgs = JSON.parse(tcMatch[2].trim()); } catch { /* skip unparseable */ }
      pushIfOffered(tcMatch[1].trim(), tcArgs);
    }
  }
  // Pattern 3: ```json\n{"name": "tool", "arguments": {...}}\n```
  let fencedAccepted = false;
  if (toolCalls.length === 0) {
    const jsonBlockRegex = new RegExp(FENCED.source, 'g');
    let jbMatch;
    while ((jbMatch = jsonBlockRegex.exec(fullText)) !== null) {
      try {
        const obj = JSON.parse(jbMatch[1]);
        if (obj.name && typeof obj.name === 'string') {
          const before = toolCalls.length;
          pushIfOffered(obj.name, (obj.arguments ?? obj.parameters ?? {}) as Record<string, unknown>);
          if (toolCalls.length > before) fencedAccepted = true;
        }
      } catch { /* not valid JSON tool call */ }
    }
  }
  // Pattern 4: <function_call name="tool" arguments='{"key": "value"}' />
  if (toolCalls.length === 0) {
    const fcRegex = /<function_call\s+name="([^"]+)"\s+arguments='([^']*)'\s*\/>/g;
    let fcMatch;
    while ((fcMatch = fcRegex.exec(fullText)) !== null) {
      let fcArgs: Record<string, unknown> = {};
      try { fcArgs = JSON.parse(fcMatch[2]); } catch { /* skip */ }
      pushIfOffered(fcMatch[1], fcArgs);
    }
  }
  // Pattern 5: <|tool_call>call:tool_name(key="value", ...)<tool_call|>  (Qwen/DeepSeek-derived)
  if (toolCalls.length === 0) {
    const pipeRegex = /<\|tool_call>call:(\w+)\(([^)]*)\)<(?:tool_call\||\|tool_call)>/g;
    let pipeMatch;
    while ((pipeMatch = pipeRegex.exec(fullText)) !== null) {
      const rawArgs = pipeMatch[2];
      const args: Record<string, unknown> = {};
      for (const pair of rawArgs.matchAll(/(\w+)="([^"]*)"/g)) args[pair[1]] = pair[2];
      for (const pair of rawArgs.matchAll(/(\w+)=([^,)"]+)/g)) {
        if (!(pair[1] in args)) args[pair[1]] = pair[2].trim();
      }
      pushIfOffered(pipeMatch[1], args);
    }
  }

  if (toolCalls.length === 0) return { toolCalls, cleanText: fullText };
  let cleanText = fullText.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '')
    .replace(/<invoke name="[^"]*">[\s\S]*?<\/invoke>/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<\|tool_call>[\s\S]*?<(?:tool_call\||\|tool_call)>/g, '')
    .replace(/<function_call[^>]*\/>/g, '');
  // A fenced block goes only when it was itself the accepted call; any other ```json example is the answer.
  if (fencedAccepted) {
    cleanText = cleanText.replace(new RegExp(FENCED.source, 'g'), (block, body: string) => {
      try {
        const obj = JSON.parse(body);
        return obj && typeof obj.name === 'string' && offered.has(obj.name) ? '' : block;
      } catch { return block; }
    });
  }
  return { toolCalls, cleanText: cleanText.trim() };
}
