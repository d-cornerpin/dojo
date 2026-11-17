import { describe, it, expect } from 'vitest';
import type { ToolCall } from '@dojo/shared';
// Loading the definitions registers every tool's declared class, as the app does at start.
import '../../tools/definitions.js';
import { classifyConcurrency, partitionTools, registerConcurrency } from '../classifiers/concurrency.js';

function tc(name: string, id = `tc_${Math.random()}`): ToolCall {
  return { id, name, arguments: {} };
}

describe('classifyConcurrency', () => {
  it('a read declared safe on its definition runs in parallel', () => {
    for (const name of ['file_read', 'vault_search', 'web_fetch', 'gmail_search', 'load_tool_docs', 'file_list',
      'share_file', 'history_get', 'history_expand', 'get_current_time']) {
      expect(classifyConcurrency(name), name).toBe('safe');
    }
  });

  it('the Office reads run in parallel too', () => {
    for (const name of ['office_get_word_document_outline', 'office_read_word_document', 'office_get_spreadsheet_range',
      'office_get_presentation_outline', 'office_read_presentation']) {
      expect(classifyConcurrency(name), name).toBe('safe');
    }
  });

  it('a write or an agent call never runs in parallel', () => {
    expect(classifyConcurrency('exec')).toBe('serial');
    for (const name of ['file_write', 'vault_remember', 'gmail_send', 'send_to_agent', 'spawn_agent', 'complete_task',
      'image_create', 'imessage_send']) {
      expect(classifyConcurrency(name), name).not.toBe('safe');
    }
  });

  it('defaults unknown tools to special (safest)', () => {
    expect(classifyConcurrency('some_unknown_future_tool')).toBe('special');
  });

  it('a registered class wins and stays registered', () => {
    expect(classifyConcurrency('made_up_demo_tool')).toBe('special');
    registerConcurrency('made_up_demo_tool', 'safe');
    expect(classifyConcurrency('made_up_demo_tool')).toBe('safe');
    expect(classifyConcurrency('made_up_demo_tool')).toBe('safe');
  });
});

describe('partitionTools', () => {
  it('groups consecutive safe reads into one batch', () => {
    const batches = partitionTools([tc('file_read', '1'), tc('file_read', '2'), tc('vault_search', '3')]);
    expect(batches).toHaveLength(1);
    expect(batches[0].category).toBe('safe');
    expect(batches[0].calls).toHaveLength(3);
  });

  it('breaks a safe batch on a serial call', () => {
    const batches = partitionTools([tc('file_read', '1'), tc('exec', '2'), tc('file_read', '3')]);
    expect(batches.map((b) => b.category)).toEqual(['safe', 'serial', 'safe']);
  });

  it('keeps each non-safe call in its own batch (no parallelism)', () => {
    const batches = partitionTools([tc('file_write', '1'), tc('file_write', '2'), tc('exec', '3'), tc('send_to_agent', '4')]);
    expect(batches).toHaveLength(4);
    for (const b of batches) expect(b.calls).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(partitionTools([])).toEqual([]);
  });

  it('preserves call order within and across batches', () => {
    const calls = [tc('file_read', 'a'), tc('vault_search', 'b'), tc('file_write', 'c'), tc('file_read', 'd'), tc('send_to_agent', 'e')];
    expect(partitionTools(calls).flatMap((b) => b.calls.map((c) => c.id))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
