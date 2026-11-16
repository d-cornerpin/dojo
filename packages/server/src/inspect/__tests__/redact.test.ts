// v3.5 inspect A1 — the redaction every dojo_inspect view passes through.
//
// Three doors, each pinned here:
//   1. refuseDeniedSql — a statement that reaches a credential table or column is refused,
//      naming it. Lexically for the denied tables (no schema needed), and, given a
//      connection, by what SQLite's own compiled program actually READS — so an alias, a
//      star or a UNION cannot carry a credential column out under another name.
//   2. redactRows — a credential column is blanked, then every string cell is scrubbed.
//   3. redactText — token-shaped strings and every value an agent has handled are scrubbed.
// Every secret below is a synthetic string built for the test; none is real.

import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { noteHandedCredentialValues } from '../../credentials/secret-values.js';
import { DENIED_TABLES, refuseDeniedSql, redactRows, redactText } from '../redact.js';

const BEARER = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const GH = `ghp_${'x1Y2z3'.repeat(6)}`;

let db: Database.Database;
beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE google_accounts (id TEXT PRIMARY KEY, email TEXT, access_token TEXT, refresh_token TEXT);
    CREATE TABLE destructive_approvals (id TEXT PRIMARY KEY, agent_id TEXT, token TEXT, created_at TEXT);
    CREATE TABLE messages (seq INTEGER PRIMARY KEY, id TEXT, agent_id TEXT, content TEXT, token_count INTEGER);
    CREATE TABLE providers (id TEXT PRIMARY KEY, measured_chars_per_token REAL, measured_chars_per_token_at TEXT);
    CREATE INDEX ix_da_token ON destructive_approvals(token);
    CREATE VIEW approval_tokens AS SELECT id, token FROM destructive_approvals;
  `);
});

describe('refuseDeniedSql', () => {
  it('names a denied table, however it is quoted', () => {
    for (const q of [
      'select * from google_accounts',
      'SELECT email FROM "Google_Accounts"',
      'select * from [google_accounts]',
      'select * from `google_accounts` g',
      'select * from main.google_accounts',
    ]) expect(refuseDeniedSql(q), q).toMatch(/google_accounts/);
    expect(DENIED_TABLES).not.toContain('vault_entries');
  });

  it('lets a statement through that only MENTIONS a denied table inside a string or a comment', () => {
    expect(refuseDeniedSql("select * from messages where content like '%google_accounts%' -- google_accounts")).toBeNull();
  });

  it('refuses a credential column in an allowed table, by what SQLite reads, through any alias', () => {
    expect(refuseDeniedSql('select token from destructive_approvals', db)).toMatch(/destructive_approvals\.token/);
    expect(refuseDeniedSql('select length(t) from (select token as t from destructive_approvals)', db)).toMatch(/destructive_approvals\.token/);
    // The star under another name: the outer select renames every column, and no column name appears at all.
    expect(refuseDeniedSql('select * from (select 1 as a, 2 as b, 3 as c, 4 as d union all select * from destructive_approvals)', db))
      .toMatch(/destructive_approvals\.token/);
    // A covering index read is still a read of the column.
    expect(refuseDeniedSql('select count(*) from destructive_approvals where token > \'\'', db)).toMatch(/destructive_approvals\.token/);
  });

  it('does not refuse a count, a rate or a timestamp whose NAME happens to say token', () => {
    expect(refuseDeniedSql('select token_count, content from messages', db)).toBeNull();
    expect(refuseDeniedSql('select measured_chars_per_token, measured_chars_per_token_at from providers', db)).toBeNull();
    expect(refuseDeniedSql('select id, agent_id, created_at from destructive_approvals', db)).toBeNull();
  });
});

describe('refuseDeniedSql — fix round 1: the word explain, every quoting form, every way round', () => {
  it("the reviewer's two probes, verbatim, are refused", () => {
    expect(refuseDeniedSql("select access_token as a, refresh_token as b, 1 as explain from 'google_accounts'", db)).toMatch(/google_accounts/);
    expect(refuseDeniedSql('select token as t, 0 as explain from destructive_approvals', db)).toMatch(/destructive_approvals\.token/);
  });

  it('a single-quoted table name is a table name to SQLite, so it is one to the scan', () => {
    expect(refuseDeniedSql("select email from 'google_accounts'")).toMatch(/google_accounts/);
    expect(refuseDeniedSql("select * from messages where content = 'google_accounts'")).toMatch(/google_accounts/);
    // A literal that merely CONTAINS the name is text, not a table.
    expect(refuseDeniedSql("select * from messages where content like '%google_accounts%'", db)).toBeNull();
  });

  it('an alias, a CTE named explain, a view, a subquery, a UNION and json_each are all refused', () => {
    for (const q of [
      'select token as innocent from destructive_approvals',
      'with explain as (select token from destructive_approvals) select * from explain',
      'select * from approval_tokens',
      'select x from (select token as x from destructive_approvals) as explain',
      'select 1, 2 union all select id, token from destructive_approvals',
      "select value from json_each((select json_group_array(access_token) from 'google_accounts'))",
      'select rawtok from (select access_token as rawtok from "google_accounts") t, (select 1 as explain) e',
    ]) expect(refuseDeniedSql(q, db), q).toMatch(/Refused/);
  });

  it('a genuine EXPLAIN is checked like the statement it explains', () => {
    expect(refuseDeniedSql('explain select token from destructive_approvals', db)).toMatch(/destructive_approvals\.token/);
    expect(refuseDeniedSql('EXPLAIN QUERY PLAN select access_token from google_accounts', db)).toMatch(/google_accounts/);
    expect(refuseDeniedSql('explain query plan select token_count from messages', db)).toBeNull();
    expect(refuseDeniedSql('explain pragma query_only = 0', db)).toMatch(/Refused/);
  });

  it("a statement SQLite cannot compile is left to SQLite's own error", () => {
    expect(refuseDeniedSql('select nope from nowhere', db)).toBeNull(); // SQLite's own error is shown where it runs
  });
});

describe('refuseDeniedSql — fix round 2', () => {
  it('sqlite_stat* is refused: ANALYZE samples index keys, credentials included, in cleartext', () => {
    const stat = new Database(':memory:');
    stat.exec('CREATE TABLE destructive_approvals (token TEXT PRIMARY KEY, agent_id TEXT)');
    for (let i = 0; i < 40; i++) stat.prepare('INSERT INTO destructive_approvals VALUES (?, ?)').run(`approval-synthetic-value-${i}`, 'a');
    stat.exec('ANALYZE');
    // The leak is real when STAT4 is compiled in: the sample holds the token.
    const sampled = stat.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_stat4'").pluck().get() === 1
      && (stat.prepare('select cast(sample as text) from sqlite_stat4').pluck().all() as string[]).some((x) => x.includes('approval-synthetic-value'));
    expect(sampled).toBe(true);
    for (const q of ['select tbl, idx, cast(sample as text) from sqlite_stat4', 'select hex(sample) from "sqlite_stat4"',
      'select * from sqlite_stat1', "select * from 'sqlite_stat3'", 'select * from main.sqlite_stat4']) {
      expect(refuseDeniedSql(q, stat), q).toMatch(/Refused: .*sqlite_stat/);
    }
  });

  it("a schema pragma names a credential table's columns, never its values", () => {
    for (const q of ["select name, type from pragma_table_info('google_accounts')", "select * from pragma_table_xinfo('google_accounts')",
      "select * from pragma_index_list('destructive_approvals')", "select * from pragma_foreign_key_list('google_accounts')"]) {
      expect(refuseDeniedSql(q, db), q).toBeNull();
    }
    expect(refuseDeniedSql("select p.name, g.access_token from pragma_table_info('google_accounts') p, google_accounts g", db)).toMatch(/Refused/);
    expect(refuseDeniedSql("select * from pragma_table_info('google_accounts') p, 'google_accounts' g", db)).toMatch(/Refused/);
    expect(refuseDeniedSql("select * from messages where content = 'google_accounts'", db)).toMatch(/Refused/);
  });
});

describe('redactRows', () => {
  it('blanks a credential column and scrubs every other string cell', () => {
    const out = redactRows([{ id: 'acct-1', access_token: 'ya29.synthetic-access-value', token_count: 12, note: `Authorization: Bearer ${BEARER}`, token_expires_at: 1792651631000 }]);
    expect(out[0].id).toBe('acct-1');
    expect(out[0].access_token).toBe('<redacted-credential>');
    expect(out[0].token_count).toBe(12);
    expect(out[0].token_expires_at).toBe(1792651631000);
    expect(out[0].note).not.toContain(BEARER);
    expect(JSON.stringify(out)).not.toContain('ya29');
  });

  it('blanks the value of a key/value row whose key names a credential', () => {
    const out = redactRows([{ key: 'some_api_key', value: 'plain-value-1234' }, { key: 'healer_time', value: '03:00' }]);
    expect(out[0].value).toBe('<redacted-credential>');
    expect(out[1].value).toBe('03:00');
  });

  it("scrubs a value the row's own agent handled", () => {
    noteHandedCredentialValues('agent-redact-test', ['handed-value-0042']);
    const out = redactRows([{ agent_id: 'agent-redact-test', content: 'used handed-value-0042 in a call' }]);
    expect(out[0].content).not.toContain('handed-value-0042');
  });
});

describe('redactText', () => {
  it('scrubs a bearer token out of a log line', () => {
    const line = `{"level":"warn","message":"upstream refused","meta":{"header":"Authorization: Bearer ${BEARER}"}}`;
    const out = redactText(line);
    expect(out).not.toContain(BEARER);
    expect(out).toContain('Bearer <redacted-credential>');
  });

  it('scrubs a key-shaped string and a value the named agents handled', () => {
    noteHandedCredentialValues('agent-redact-test-2', ['gate-code-777111']);
    const out = redactText(`token ${GH} and gate-code-777111`, ['agent-redact-test-2']);
    expect(out).not.toContain(GH);
    expect(out).not.toContain('gate-code-777111');
  });

  it('returns ordinary text unchanged', () => {
    expect(redactText('the task closed at 09:23 with 3 tool calls')).toBe('the task closed at 09:23 with 3 tool calls');
  });
});
