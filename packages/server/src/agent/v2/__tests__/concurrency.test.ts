import { describe, it, expect } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import { classifyConcurrency, partitionTools, registerConcurrency } from '../classifiers/concurrency.js';

function tc(name: string, id = `tc_${Math.random()}`): ToolCall {
  return { id, name, arguments: {} };
}

describe('classifyConcurrency', () => {
  it('classifies known read tools as safe', () => {
    expect(classifyConcurrency('file_read')).toBe('safe');
    expect(classifyConcurrency('vault_search')).toBe('safe');
    expect(classifyConcurrency('web_fetch')).toBe('safe');
    expect(classifyConcurrency('gmail_search')).toBe('safe');
  });

  it('classifies known writes as serial', () => {
    expect(classifyConcurrency('file_write')).toBe('serial');
    expect(classifyConcurrency('exec')).toBe('serial');
    expect(classifyConcurrency('vault_remember')).toBe('serial');
    expect(classifyConcurrency('gmail_send')).toBe('serial');
  });

  it('classifies multi-agent tools as agent', () => {
    expect(classifyConcurrency('send_to_agent')).toBe('agent');
    expect(classifyConcurrency('spawn_agent')).toBe('agent');
    expect(classifyConcurrency('broadcast_to_group')).toBe('agent');
  });

  it('classifies special-purpose tools as special', () => {
    expect(classifyConcurrency('complete_task')).toBe('special');
    expect(classifyConcurrency('image_create')).toBe('special');
    expect(classifyConcurrency('show_to_user')).toBe('special');
    expect(classifyConcurrency('imessage_send')).toBe('special');
  });

  it('defaults unknown tools to special (safest)', () => {
    expect(classifyConcurrency('some_unknown_future_tool')).toBe('special');
  });
});

describe('partitionTools', () => {
  it('groups consecutive safe reads into one batch', () => {
    const calls = [tc('file_read', '1'), tc('file_read', '2'), tc('vault_search', '3')];
    const batches = partitionTools(calls);
    expect(batches).toHaveLength(1);
    expect(batches[0].category).toBe('safe');
    expect(batches[0].calls).toHaveLength(3);
  });

  it('breaks safe batch on serial call', () => {
    const calls = [tc('file_read', '1'), tc('file_write', '2'), tc('file_read', '3')];
    const batches = partitionTools(calls);
    expect(batches).toHaveLength(3);
    expect(batches[0].category).toBe('safe');
    expect(batches[1].category).toBe('serial');
    expect(batches[2].category).toBe('safe');
  });

  it('keeps each serial call in its own batch (no parallelism)', () => {
    const calls = [tc('file_write', '1'), tc('file_write', '2'), tc('exec', '3')];
    const batches = partitionTools(calls);
    expect(batches).toHaveLength(3);
    for (const b of batches) {
      expect(b.calls).toHaveLength(1);
    }
  });

  it('keeps each agent call in its own batch', () => {
    const calls = [tc('send_to_agent', '1'), tc('send_to_agent', '2')];
    const batches = partitionTools(calls);
    expect(batches).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(partitionTools([])).toEqual([]);
  });

  it('preserves call order within and across batches', () => {
    const calls = [
      tc('file_read', 'a'),
      tc('vault_search', 'b'),
      tc('file_write', 'c'),
      tc('file_read', 'd'),
      tc('send_to_agent', 'e'),
    ];
    const batches = partitionTools(calls);
    const flat = batches.flatMap((b) => b.calls.map((c) => c.id));
    expect(flat).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('does not merge adjacent batches of the same non-safe category', () => {
    // Two file_writes should stay as 2 separate single-element batches
    // so each gets its own awaited execution (no accidental parallelism).
    const calls = [tc('file_write', '1'), tc('file_write', '2')];
    const batches = partitionTools(calls);
    expect(batches).toHaveLength(2);
    expect(batches.every((b) => b.calls.length === 1)).toBe(true);
  });
});

describe('Phase 3 — registry-first lookup (registerConcurrency)', () => {
  it('definition-level override beats the hardcoded TOOL_CATEGORY map', () => {
    // The hardcoded map says 'made_up_demo_tool' is unknown → 'special'.
    // Registering it as 'safe' should make classifyConcurrency report 'safe'.
    expect(classifyConcurrency('made_up_demo_tool_phase3')).toBe('special');
    registerConcurrency('made_up_demo_tool_phase3', 'safe');
    expect(classifyConcurrency('made_up_demo_tool_phase3')).toBe('safe');
  });

  it('falls back to TOOL_CATEGORY when no override is registered', () => {
    expect(classifyConcurrency('file_read')).toBe('safe');
    expect(classifyConcurrency('exec')).toBe('serial');
  });

  it('overrides are sticky across calls', () => {
    registerConcurrency('phase3_sticky', 'agent');
    expect(classifyConcurrency('phase3_sticky')).toBe('agent');
    expect(classifyConcurrency('phase3_sticky')).toBe('agent');
  });
});
