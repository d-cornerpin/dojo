import { describe, it, expect } from 'vitest';
import { validateToolArgs, PER_TOOL_VALIDATED_AT_BOUNDARY } from '../validate-args.js';
import { checkRequired, type FieldSpec } from '../../tool-helpers.js';
import { getAllToolDefinitions, isBoundaryValidated } from '../definitions.js';
import type { ToolDefinition } from '../types.js';
import { checkEffectDeclarations } from './effect-conformance.js';
import { classifyToolResult, toolResultOf, toolWasBlocked } from '../../tool-outcome.js';

const defsByName = new Map<string, ToolDefinition>(
  getAllToolDefinitions().map((d) => [d.name, d] as const),
);
const def = (name: string): ToolDefinition => {
  const d = defsByName.get(name);
  if (!d) throw new Error(`no such tool definition: ${name}`);
  return d;
};

// The description tells the model an empty query returns the most recently
// updated contacts, and the handler works it. The boundary must not refuse it.
describe('contact_search — an empty query is a real, working call', () => {
  it('accepts an empty query', () => {
    expect(validateToolArgs(def('contact_search'), { query: '' })).toBeNull();
  });

  it('accepts a whitespace-only query', () => {
    expect(validateToolArgs(def('contact_search'), { query: '   ' })).toBeNull();
  });

  it('a missing query is still refused', () => {
    expect(validateToolArgs(def('contact_search'), {})).toBe('Error: `query` is required.');
  });

  it('a non-string query is still refused with the type message', () => {
    expect(validateToolArgs(def('contact_search'), { query: 5 })).toBe(
      'Error: `query` must be a string (got number).',
    );
  });

  it('a real query passes', () => {
    expect(validateToolArgs(def('contact_search'), { query: 'ann' })).toBeNull();
  });
});
