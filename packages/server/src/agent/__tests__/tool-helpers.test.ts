// Property-style tests for the bulletproof helpers in agent/tool-helpers.ts.
//
// These helpers are the foundation of tool input validation, error
// translation, and reference resolution. The tests pin the contracts so a
// future change can't quietly weaken what tier-1 tools depend on.
//
// Properties checked:
//  - checkRequired: returns null on valid, returns a *user-readable* string
//    error on every invalid case (never throws, never returns undefined)
//  - friendlyDbError: translates known SQLite errors to actionable strings,
//    falls through cleanly on unknown errors
//  - pickArg: picks first defined value, returns undefined when nothing matches

import { describe, it, expect } from 'vitest';
import {
  checkRequired,
  friendlyDbError,
  pickArg,
  isTerminalAgentStatus,
  isTerminalTaskStatus,
  type FieldSpec,
} from '../tool-helpers.js';

describe('checkRequired', () => {
  it('returns null when all fields are valid', () => {
    const spec: FieldSpec[] = [
      { name: 'title', value: 'a project', type: 'string' },
      { name: 'count', value: 3, type: 'number' },
      { name: 'enabled', value: true, type: 'boolean' },
      { name: 'items', value: ['a'], type: 'array' },
    ];
    expect(checkRequired(spec)).toBeNull();
  });

  it('flags undefined values with the field name in the error', () => {
    const result = checkRequired([{ name: 'task_id', value: undefined, type: 'string' }]);
    expect(result).toBeTypeOf('string');
    expect(result).toContain('task_id');
    expect(result).toContain('required');
  });

  it('flags null values', () => {
    const result = checkRequired([{ name: 'agent', value: null, type: 'string' }]);
    expect(result).toContain('agent');
    expect(result).toContain('required');
  });

  it('flags wrong type with the actual type included', () => {
    const result = checkRequired([{ name: 'count', value: 'three', type: 'number' }]);
    expect(result).toContain('count');
    expect(result).toContain('number');
    expect(result).toContain('string'); // tells the agent what they passed
  });

  it('flags empty strings unless allowEmpty is set', () => {
    expect(checkRequired([{ name: 'title', value: '', type: 'string' }])).toContain('cannot be empty');
    expect(checkRequired([{ name: 'title', value: '   ', type: 'string' }])).toContain('cannot be empty');
    expect(checkRequired([{ name: 'title', value: '', type: 'string', allowEmpty: true }])).toBeNull();
  });

  it('flags empty arrays unless allowEmpty is set', () => {
    expect(checkRequired([{ name: 'tags', value: [], type: 'array' }])).toContain('cannot be empty');
    expect(checkRequired([{ name: 'tags', value: [], type: 'array', allowEmpty: true }])).toBeNull();
  });

  it('returns the FIRST failing field, not all of them', () => {
    const result = checkRequired([
      { name: 'task_id', value: undefined, type: 'string' },
      { name: 'status', value: undefined, type: 'string' },
    ]);
    expect(result).toContain('task_id');
    expect(result).not.toContain('status'); // stops at first
  });

  it('treats arrays correctly (not as objects)', () => {
    expect(checkRequired([{ name: 'tags', value: ['a', 'b'], type: 'array' }])).toBeNull();
    expect(checkRequired([{ name: 'tags', value: { 0: 'a' }, type: 'array' }])).toContain('array');
  });

  it('never throws on weird inputs', () => {
    // Symbols, functions, NaN — should all return a string error or null,
    // never crash the helper.
    const weird: FieldSpec[] = [
      { name: 'x', value: Symbol('x'), type: 'string' },
      { name: 'y', value: () => 1, type: 'number' },
      { name: 'z', value: NaN, type: 'string' },
    ];
    for (const f of weird) {
      const result = checkRequired([f]);
      expect(typeof result).toBe('string');
    }
  });
});

describe('friendlyDbError', () => {
  it('translates FK constraint failures with the table name when present', () => {
    const err = new Error('FOREIGN KEY constraint failed: agents.name');
    const result = friendlyDbError(err, 'tracker_create_task');
    expect(result).toContain('tracker_create_task');
    expect(result).toContain("doesn't exist");
    expect(result).toContain('agents.name');
  });

  it('translates plain FK errors without table info', () => {
    const err = new Error('FOREIGN KEY constraint failed');
    const result = friendlyDbError(err);
    expect(result).toContain("doesn't exist");
    // No raw "FOREIGN KEY constraint" leak in the user-facing string
    expect(result).not.toMatch(/FOREIGN KEY constraint/i);
  });

  it('translates NOT NULL constraint failures with the field name', () => {
    const err = new Error('NOT NULL constraint failed: agents.name');
    const result = friendlyDbError(err);
    expect(result).toContain('agents.name');
    expect(result).toMatch(/required|missing/i);
  });

  it('translates UNIQUE constraint failures', () => {
    const err = new Error('UNIQUE constraint failed: techniques.id');
    const result = friendlyDbError(err);
    expect(result).toMatch(/already exists|duplicate/i);
    expect(result).toContain('techniques.id');
  });

  it('translates CHECK constraint failures', () => {
    const err = new Error('CHECK constraint failed: status');
    const result = friendlyDbError(err);
    expect(result).toMatch(/range|allowed|valid/i);
  });

  it('handles "database is locked" with retry guidance', () => {
    const err = new Error('database is locked');
    const result = friendlyDbError(err);
    expect(result).toMatch(/busy|retry/i);
  });

  it('falls through unknown errors with the original message preserved', () => {
    const err = new Error('something exotic happened');
    const result = friendlyDbError(err, 'my_tool');
    expect(result).toContain('my_tool');
    expect(result).toContain('something exotic happened');
  });

  it('handles non-Error throws (string, number, undefined)', () => {
    expect(friendlyDbError('plain string')).toContain('plain string');
    expect(friendlyDbError(42)).toContain('42');
    expect(typeof friendlyDbError(undefined)).toBe('string');
    expect(typeof friendlyDbError(null)).toBe('string');
  });

  it('always includes the context prefix when provided', () => {
    const err = new Error('whatever');
    const result = friendlyDbError(err, 'gmail_send');
    expect(result.startsWith('gmail_send')).toBe(true);
  });
});

describe('pickArg', () => {
  it('returns the first defined value', () => {
    expect(pickArg<string>({ a: 'x', b: 'y' }, 'a', 'b')).toBe('x');
    expect(pickArg<string>({ b: 'y' }, 'a', 'b')).toBe('y');
  });

  it('returns undefined when nothing matches', () => {
    expect(pickArg<string>({}, 'a', 'b')).toBeUndefined();
    expect(pickArg<string>({ c: 'z' }, 'a', 'b')).toBeUndefined();
  });

  it('treats null as defined (only undefined skips)', () => {
    // We want to distinguish "not passed" from "passed as null".
    // A consumer can decide what to do with null; we shouldn't paper over it.
    expect(pickArg<string | null>({ a: null }, 'a', 'b')).toBeNull();
  });

  it('handles falsy values correctly', () => {
    expect(pickArg<number>({ a: 0 }, 'a', 'b')).toBe(0);
    expect(pickArg<string>({ a: '' }, 'a', 'b')).toBe('');
    expect(pickArg<boolean>({ a: false }, 'a', 'b')).toBe(false);
  });
});

describe('isTerminalAgentStatus', () => {
  it('only "terminated" is terminal', () => {
    expect(isTerminalAgentStatus('terminated')).toBe(true);
    expect(isTerminalAgentStatus('idle')).toBe(false);
    expect(isTerminalAgentStatus('working')).toBe(false);
    expect(isTerminalAgentStatus('error')).toBe(false);
    expect(isTerminalAgentStatus(null)).toBe(false);
    expect(isTerminalAgentStatus(undefined)).toBe(false);
  });
});


describe('isTerminalTaskStatus', () => {
  it('"complete" and "fallen" are terminal; others are not', () => {
    expect(isTerminalTaskStatus('complete')).toBe(true);
    expect(isTerminalTaskStatus('fallen')).toBe(true);
    expect(isTerminalTaskStatus('blocked')).toBe(false); // blocked is NOT terminal — can resume
    expect(isTerminalTaskStatus('in_progress')).toBe(false);
    expect(isTerminalTaskStatus('on_deck')).toBe(false);
    expect(isTerminalTaskStatus(null)).toBe(false);
  });
});
