import { describe, it, expect } from 'vitest';
import { formatTierBNoteForAgent } from '../error-format.js';
import { classifyRecoverableProviderError } from '../classifiers/provider.js';
import { getAllToolDefinitions } from '../../tools/definitions.js';

describe('unknown-tool notes name a tool that exists', () => {
  it('the note for an unknown tool names only tools that exist', () => {
    const names = new Set(getAllToolDefinitions().map((t) => t.name));
    for (const note of [
      formatTierBNoteForAgent('tool_name_unknown', { toolName: 'memry_save' }),
      formatTierBNoteForAgent('tool_name_unknown', {}),
    ]) {
      expect(note).not.toContain('list_tool_docs');
      expect(note).toContain('load_tool_docs');
      expect(names.has('load_tool_docs')).toBe(true);
    }
  });

  it('the provider guidance for an unknown tool names load_tool_docs', () => {
    const r = classifyRecoverableProviderError('400 invalid_request_error: tool "memry_save" does not exist');
    expect(r!.guidance).not.toContain('list_tool_docs');
    expect(r!.guidance).toContain('load_tool_docs');
  });
});
