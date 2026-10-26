// v3.5 inspect A1 — the per-cell helpers of the redaction every dojo_inspect view passes through.
//
// The SQL-level refusal and the whole-row / log-line doors are pinned in redact.test.ts;
// this file pins the smaller pieces redactRows is built from, so a credential-named column
// is still blanked, a key/value row's value is blanked when its KEY names a credential, a
// count or a timestamp is left alone, and a row's own agents are read for the handed-value
// scrub. A value is compared to REDACTED_CREDENTIAL, never to a literal of it. Every credential
// below is a synthetic value; none is real.

import { describe, it, expect } from 'vitest';
import {
  isDeniedColumn,
  columnNamesCredential,
  redactCell,
  rowAgents,
  keyNamesCredential,
  redactRows,
} from '../redact.js';
import { REDACTED_CREDENTIAL } from '../../credentials/secret-values.js';

describe('isDeniedColumn', () => {
  it('a name that says credential is denied unless its type is a number or its name ends in _at', () => {
    const cases: Array<[string, string, boolean]> = [
      ['access_token', 'TEXT', true],
      ['Api_Key', 'text', true],
      ['refresh_token', '', true],
      ['private_note', 'TEXT', true],
      ['max_tokens', 'INTEGER', false],
      ['token_expires_at', 'TEXT', false],
      ['name', 'TEXT', false],
      ['is_private', 'BOOLEAN', false],
    ];
    for (const [name, declaredType, want] of cases) {
      expect(isDeniedColumn(name, declaredType), `${name}/${declaredType}`).toBe(want);
    }
  });
});

describe('columnNamesCredential', () => {
  it('a bare name says credential — the column-name test without a declared type', () => {
    expect(columnNamesCredential('secret_x')).toBe(true);
  });
});

describe('redactCell', () => {
  it('blanks a credential column that holds bytes, and leaves a non-byte value or an ordinary column', () => {
    expect(redactCell('access_token', 'abc', [])).toBe(REDACTED_CREDENTIAL);
    expect(redactCell('access_token', Buffer.from('x'), [])).toBe(REDACTED_CREDENTIAL);
    expect(redactCell('access_token', 42, [])).toBe(42);
    expect(redactCell('access_token', null, [])).toBeNull();
    expect(redactCell('title', 'hello', [])).toBe('hello');
  });

  it('blanks the value of a key/value row only when its key names a credential', () => {
    expect(redactCell('value', 'v', [], true)).toBe(REDACTED_CREDENTIAL);
    expect(redactCell('value', 'v', [], false)).toBe('v');
    expect(redactCell('value', 7, [], true)).toBe(7);
  });
});

describe('rowAgents', () => {
  it('reads the agent cells, dropping a non-string value, after the base agents', () => {
    expect(
      rowAgents([
        ['agent_id', 'a1'],
        ['name', 'n'],
        ['source_agent_id', null],
        ['assignee_agent', 'a2'],
        ['created_by_agent_id', 5],
      ], ['base']),
    ).toEqual(['base', 'a1', 'a2']);
  });

  it('a row with no agent cells yields the base alone', () => {
    expect(rowAgents([])).toEqual([]);
  });
});

describe('keyNamesCredential', () => {
  it('a string key that names a credential (the config table shape)', () => {
    expect(keyNamesCredential('github_token')).toBe(true);
    expect(keyNamesCredential('theme')).toBe(false);
    expect(keyNamesCredential(5)).toBe(false);
    expect(keyNamesCredential('token_updated_at')).toBe(false);
  });
});

describe('redactRows', () => {
  it('blanks the value of a key/value row whose key names a credential, and leaves an ordinary row', () => {
    const out = redactRows<Record<string, unknown>>([
      { key: 'api_key', value: 'sk-xyz', id: 1 },
      { key: 'theme', value: 'dark' },
    ]);
    expect(out).toEqual([
      { key: 'api_key', value: REDACTED_CREDENTIAL, id: 1 },
      { key: 'theme', value: 'dark' },
    ]);
  });
});
