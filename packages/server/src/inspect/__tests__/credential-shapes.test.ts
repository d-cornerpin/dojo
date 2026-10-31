// t285 — three credential holes in dojo_inspect, each pinned (red before the fix, green after).
//   R1  the text scrubber knows every credential shape the Dojo stores or handles.
//   R2  a config value is blanked whenever its row's key names a credential, whatever columns
//       the query selected; a statement that reads the value without its key is refused.
//   R3  code search can only search the Dojo's own repository (see source-remote-scope.test.ts).
// Every credential below is a synthetic string built for the test; none is real.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { redactText, refuseDeniedSql } from '../redact.js';
import { redactResultRow } from '../result-row.js';

const BODY = 'Zq9Xk2Lm4Np6Rs8Tv0Wy1Ab3Cd5Ef7Gh';
const MARK = '<redacted-credential>';

describe('R1: redactText knows every shape the Dojo stores or handles', () => {
  it('Google OAuth access and refresh tokens', () => {
    expect(redactText(`got ya29.a0Synthetic_${BODY} ok`)).not.toContain(BODY);
    expect(redactText(`refresh 1//0gSynthetic-${BODY} ok`)).not.toContain(BODY);
  });
  it('a PEM private-key block, whole, with the lines between', () => {
    const pem = `before\n-----BEGIN RSA PRIVATE KEY-----\n${BODY}\nSecondLine${BODY}\n-----END RSA PRIVATE KEY-----\nafter`;
    const out = redactText(pem);
    expect(out).not.toContain(BODY);
    expect(out).not.toContain('BEGIN RSA');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });
  it('a private-key block cut off before its END line is still blanked to the end', () => {
    expect(redactText(`-----BEGIN PRIVATE KEY-----\n${BODY}`)).not.toContain(BODY);
  });
  it('JSON pairs with a credential name, in any case; key and punctuation stay', () => {
    for (const k of ['access_token', 'refresh_token', 'client_secret', 'password', 'Access_Token', 'apiKey', 'api_key']) {
      const out = redactText(`{"${k}":"${BODY}","other":"fine"}`);
      expect(out, k).not.toContain(BODY);
      expect(out, k).toContain(`"${k}":"${MARK}"`);
      expect(out, k).toContain('"other":"fine"');
    }
  });
  it('name=value and name: value in lowercase and mixed case', () => {
    for (const s of [`password=${BODY}`, `client_secret: ${BODY}`, `Api_Key = ${BODY}`, `token: "${BODY}"`, `db_password=hunter22`]) {
      expect(redactText(s), s).not.toMatch(/Zq9Xk2|hunter22/);
    }
    expect(redactText(`password=${BODY}`)).toMatch(/^password=/);
  });
  it('GitHub fine-grained tokens', () => {
    expect(redactText(`x github_pat_11ABCDEFG0${BODY}_${BODY} y`)).not.toContain(BODY);
  });
  it('HTTP Basic auth values', () => {
    const b64 = Buffer.from('someuser:somepassword1').toString('base64');
    expect(redactText(`Authorization: Basic ${b64}`)).not.toContain(b64);
    expect(redactText(`curl -H "authorization: basic ${b64}"`)).not.toContain(b64);
  });
  it('ordinary text is unchanged', () => {
    for (const s of [
      'Please reset your password to continue.',
      'The password field is required, and a token is a string.',
      'commit 3f786850e387550fdab836ed7e6dc881de23001b',
      'id 123e4567-e89b-12d3-a456-426614174000 done',
      'Basic information about the project',
    ]) expect(redactText(s), s).toBe(s);
  });
});

describe('R2: a config value is never returned when its row is a credential', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
           INSERT INTO config VALUES ('example_api_key', 'synthetic-secret-value-001', 'x'), ('theme', 'dark', 'x');`);
  const refused = (q: string): boolean => /^Refused: .*config/.test(refuseDeniedSql(q, db) ?? '');

  it('refuses every shape that reads the value without the key of the same row', () => {
    for (const q of [
      "select value from config where key like '%api_key%'",
      "select value as v from config",
      "select substr(value, 1, 5) from config",
      "select (select value from config where key = 'example_api_key')",
      "select a.value from config a join config b on a.key = b.key",
      "select a.key, b.value from config a, config b",
      "select length(value) from config",
    ]) expect(refused(q), q).toBe(true);
  });
  it('lets a statement through that selects the key with the value, and one that does not read the value', () => {
    expect(refuseDeniedSql('select key, value from config', db)).toBeNull();
    expect(refuseDeniedSql('select * from config', db)).toBeNull();
    expect(refuseDeniedSql('select key, updated_at from config', db)).toBeNull();
    expect(refuseDeniedSql('select count(*) from config', db)).toBeNull();
  });
  it('blanks every other cell of a credential-keyed config row, including an expression over the value', () => {
    const cols = [
      { name: 'key', column: 'key', table: 'config' },
      { name: 'v', column: 'value', table: 'config' },
      { name: 'substr(value,1,5)', column: null, table: null },
    ];
    expect(redactResultRow(cols, ['example_api_key', 'synthetic-secret-value-001', 'synth'], [])).toEqual(['example_api_key', MARK, MARK]);
    expect(redactResultRow(cols, ['theme', 'dark', 'dark'], [])).toEqual(['theme', 'dark', 'dark']);
  });
});
