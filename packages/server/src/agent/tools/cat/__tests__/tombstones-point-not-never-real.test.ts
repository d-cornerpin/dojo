// ════════════════════════════════════════════════════════════════════════════
// T80 FIX-WAVE ITEM 1 — A TOMBSTONED NAME GETS ITS POINTER, NOT "NEVER REAL".
//
// THE DEFECT: `load_tool_docs` canonicalized alias RENAMES before
// classification (`tools/aliases.ts`'s rename entries) but let a TOMBSTONED
// name (a removed tool with no replacement — `isTombstone` entries, e.g.
// `tracker_edit_notes`) fall through to `describeNameFailure`, which told the
// model "no similar tool name found... the tool was never real" — while the
// alias table holds the exact remedial pointer the whole time.
//
// Driven-confirmed output pre-fix: `load_tool_docs(["tracker_edit_notes"])`
// -> "...no similar tool name found; the name may simply be wrong... the tool
// was never real."
//
// The execution path (`agent/tools/index.ts:180-182`) already special-cases
// tombstones ahead of dispatch and returns the pointer directly. This suite
// pins `load_tool_docs` mirroring that same lookup: a tombstoned name is
// EXCLUDED from the unknown-name classification entirely, and its pointer
// text is surfaced verbatim instead.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import type { ToolDefinition } from '../../types.js';

vi.mock('../../surface.js', () => ({
  getFilteredTools: vi.fn(),
}));
vi.mock('../../definitions.js', () => ({
  getAllToolDefinitions: vi.fn(),
}));
vi.mock('../../../../tools/tool-docs.js', () => ({
  executeLoadToolDocs: vi.fn(),
}));

import { getFilteredTools } from '../../surface.js';
import { getAllToolDefinitions } from '../../definitions.js';
import { executeLoadToolDocs } from '../../../../tools/tool-docs.js';
import { metaHandlers } from '../meta.js';

function tool(name: string): ToolDefinition {
  return { name, description: `test tool ${name}`, input_schema: { type: 'object', properties: {}, required: [] }, effects: [] };
}

// A plausible allow list for an agent that would once have held the old
// verb-collapse names: the real replacements are on it, the tombstoned names
// are not (they were removed with no replacement tool of the same name).
const ALLOWED = [tool('work_note'), tool('work_update'), tool('file_read'), tool('load_tool_docs')];

function call(args: Record<string, unknown>) {
  return metaHandlers.load_tool_docs({
    agentId: 'agent-1',
    name: 'load_tool_docs',
    args,
    callId: 'call_1',
    toolCall: { id: 'call_1', name: 'load_tool_docs', arguments: args } as ToolCall,
  });
}

beforeEach(() => {
  vi.mocked(getFilteredTools).mockReturnValue(ALLOWED);
  vi.mocked(getAllToolDefinitions).mockReturnValue(ALLOWED);
  vi.mocked(executeLoadToolDocs).mockImplementation((_agentId: string, names: string[]) => `DOCS FOR: ${names.join(', ')}`);
});

describe('load_tool_docs — a lone tombstoned request gets the pointer, never "never real"', () => {
  it('surfaces the tombstone pointer verbatim', async () => {
    const result = await call({ tools: ['tracker_edit_notes'] });
    expect(result.content).toContain('tracker_edit_notes was removed');
    expect(result.content).toContain('work_note({ task_id, notes })');
  });

  it('never says the tool was never real, and never falls back to "no similar tool name found"', async () => {
    const result = await call({ tools: ['tracker_edit_notes'] });
    expect(result.content).not.toMatch(/never real/i);
    expect(result.content).not.toMatch(/no similar tool name found/i);
  });

  it('is still reported as an error (the request as a whole yielded no docs)', async () => {
    const result = await call({ tools: ['tracker_edit_notes'] });
    expect(result.isError).toBe(true);
  });
});

describe('load_tool_docs — two tombstones and nothing else: both pointers present, no naming-failure wording at all', () => {
  it('surfaces both pointers verbatim', async () => {
    const result = await call({ tools: ['tracker_edit_notes', 'tracker_clear_notes'] });
    expect(result.content).toContain('tracker_edit_notes was removed');
    expect(result.content).toContain('tracker_clear_notes was removed');
    expect(result.content).not.toMatch(/never real/i);
  });
});

describe('load_tool_docs — mixed request (one tombstone + one unknown + one valid) yields all three texts correctly', () => {
  it('the valid tool\'s docs, the tombstone\'s verbatim pointer, and the unknown name\'s naming-failure text all appear, and the tombstone is not mislabeled unknown', async () => {
    const result = await call({ tools: ['tracker_edit_notes', 'totally_made_up_tool', 'work_note'] });

    // The valid tool's docs came through.
    expect(result.content).toContain('DOCS FOR: work_note');
    // The tombstone's pointer, verbatim.
    expect(result.content).toContain('tracker_edit_notes was removed');
    // The genuinely unknown name gets the real naming-failure text.
    expect(result.content).toContain('totally_made_up_tool');
    expect(result.content).toMatch(/does not exist/i);
    // The tombstoned name must never appear inside the "does not exist"
    // sentence — it is not classified unknown, it gets its own pointer.
    const doesNotExistSentence = result.content.match(/This tool name does not exist:.*?\./)?.[0] ?? '';
    expect(doesNotExistSentence).toContain('totally_made_up_tool');
    expect(doesNotExistSentence).not.toContain('tracker_edit_notes');
    // Overall the call succeeded (docs for the valid tool were returned).
    expect(result.isError).toBe(false);
  });
});
