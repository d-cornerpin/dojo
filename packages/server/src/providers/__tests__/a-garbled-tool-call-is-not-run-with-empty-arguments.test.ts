// A text tool call whose <arguments> body is not valid JSON must not become a call with empty
// arguments. It carries the engine's malformed-arguments marker, which the tool door answers as
// a tool error (PARSE_ERROR) without running the tool. Fake data only.
import { describe, it, expect } from 'vitest';
import { parseToolCallsFromText } from '../anthropic-sdk.js';

const block = (name: string, args: string) => `<tool_call><name>${name}</name><arguments>${args}</arguments></tool_call>`;

describe('SDK text tool calls with garbled arguments', () => {
  it('a garbled block carries the malformed marker and no real arguments', () => {
    const { toolCalls, cleanText } = parseToolCallsFromText(`Doing it. ${block('list_things', '{"a": }')}`, ['list_things']);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments).toEqual({ __malformed_args: '{"a": }' });
    expect(cleanText).toBe('Doing it.');
  });
  it('the raw text kept for the model is cut to 500 characters', () => {
    const { toolCalls } = parseToolCallsFromText(block('list_things', '{' + 'x'.repeat(900)), ['list_things']);
    expect(String(toolCalls[0].arguments.__malformed_args)).toHaveLength(500);
  });
  it('a good block beside a garbled one keeps its own arguments', () => {
    const { toolCalls } = parseToolCallsFromText(`${block('a_tool', '{"a": }')} ${block('b_tool', '{"x":1}')}`, ['a_tool', 'b_tool']);
    expect(toolCalls.map(c => c.arguments)).toEqual([{ __malformed_args: '{"a": }' }, { x: 1 }]);
  });
  it('valid blocks behave as before', () => {
    const { toolCalls } = parseToolCallsFromText(block('b_tool', '{"x":1}'), ['b_tool']);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments).toEqual({ x: 1 });
  });
});
