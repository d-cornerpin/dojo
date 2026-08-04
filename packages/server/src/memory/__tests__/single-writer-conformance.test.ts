// PHASE-1 T3 Step 4 — the single-writer conformance walk.
//
// This is the whole of Phase 1's single-writer guarantee. It walks the source with
// fs.readFileSync (never grep — two of this tree's largest files carry NUL bytes and grep
// skips them silently) and fails on any write against `messages` / `inter_agent_messages`
// outside the writer module that is not on the burn-down allowlist.
//
// THE ALLOWLIST IS THE ARTEFACT. It starts at the measured writer set and T4 empties it,
// file by file. Its length is the honest answer to "how much of the conversion is left".
//
// WHY THE MATCHER IS SHAPED THE WAY IT IS — measured at 24fe27e, not assumed:
//   * 87 INSERTs against `messages`: 7 plain `INSERT INTO`, 80 `INSERT OR IGNORE INTO`,
//     0 `INSERT OR REPLACE`. A literal gate on `INSERT INTO messages` sees 7 of 87 —
//     80 writers would sail straight through the check that IS the guarantee.
//   * `memory/interagent.ts:115` is `${verb} INTO inter_agent_messages`, where verb is
//     computed at :113. NO literal for INSERT or INSERT OR IGNORE matches it. So the match
//     is on the TABLE side (`INTO <table>`), never on the verb.
//   * `messages_fts` must NOT count. `messages\b` excludes it because `_` is a word
//     character — that word-boundary discipline is load-bearing and is self-tested below.
//   * UPDATE and DELETE count too: a single-writer rule that only covers INSERT is not one.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', '..');
const WRITER_MODULE = 'memory/message-store.ts';

/** Every write form, matched on the table rather than the verb.
 *
 *  PHASE-1 T4 added `agent_messages` — the THIRD store, folded into the unified table
 *  in cluster 3 (agent/agent-bus.ts). It is listed here with no allowlist entry, which
 *  is the strongest form this walk has: the fold is complete, so any reappearance of a
 *  write against that table fails immediately rather than waiting for T10 to notice.
 *  The word boundary that keeps `messages_fts` out also keeps these three names from
 *  matching each other, which is exactly the mistake an earlier correction made. */
const WRITE_RE = new RegExp(
  [
    // INSERT / INSERT OR <anything> / an interpolated verb, INTO one of the three tables
    // or into an interpolated table name.
    String.raw`(?:INSERT(?:\s+OR\s+\w+)?|\$\{\w+\})\s+INTO\s+(?:messages\b|inter_agent_messages\b|agent_messages\b|\$\{)`,
    String.raw`UPDATE\s+(?:messages\b|inter_agent_messages\b|agent_messages\b|\$\{)`,
    String.raw`DELETE\s+FROM\s+(?:messages\b|inter_agent_messages\b|agent_messages\b|\$\{)`,
  ].join('|'),
  'i',
);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts')) acc.push(fp);
  }
  return acc;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const sourceFiles = () => walk(SRC).map(rel).sort();
const read = (r: string) => fs.readFileSync(path.join(SRC, r), 'utf8');

// ── The burn-down allowlist ──
// Measured at 24fe27e by:
//   git grep -lP '(INSERT(\s+OR\s+\w+)?|\$\{\w+\})\s+INTO\s+(messages\b|inter_agent_messages\b|\$\{)
//               |UPDATE\s+(messages\b|inter_agent_messages\b|\$\{)
//               |DELETE\s+FROM\s+(messages\b|inter_agent_messages\b|\$\{)'
//     HEAD -- packages/server/src | grep -v __tests__ | grep -v db/migrations
// => 42 files, 136 statement sites. T4 drives this to zero, cluster by cluster.
// T4 BURN-DOWN LOG — each line is one cluster's commit, and the number is the count
// this array held after it. 42 → 0 is the task.
//   T4 cluster 1 (engine/loop):  −6  →  36   loop, counterparty, engine-steer,
//                                            recovery, inbound-channel, compaction
//   T4 cluster 2 (agent + fold): −8  →  28   a2a-transport, tools, model, spawner,
//                                            rate-limit-retry, model-switch,
//                                            destructive-gate, interagent (the shim)
//   T4 cluster 3 (gateway):      −6  →  22   routes/agents, routes/chat,
//                                            routes/setup-deps, routes/system,
//                                            routes/twilio, index — plus the THIRD
//                                            store `agent_messages` folded in
//                                            (agent/agent-bus.ts), which is why the
//                                            matcher above now names it.
//   T4 cluster 4 (services etc):−13  →   9   imessage-bridge, gmail/outlook/teams
//                                            watchers, video-job-poller,
//                                            generation-jobs, sms-inbound,
//                                            call-session, session-record, voice-ws,
//                                            reauth-notice, healer-agent
//   T4 cluster 5 (tracker/vault): −9  →   0   imaginer-agent, trainer-agent,
//                                            share-import, audit-migration,
//                                            pm-agent, notify, tracker/tools,
//                                            scheduler/runner, vault/maintenance
//
// ZERO. Every write against `messages`, `inter_agent_messages` and `agent_messages` in the
// running platform now goes through memory/message-store.ts. The one file that still
// contains such a statement is `migration/path-migration.ts`, and it is EXEMPT rather than
// allowlisted — see OFFLINE_DB_TOOLS below and the test that keeps that exemption honest.
//
// Emptying this list is what licensed T4's finishing move: migration 128 drops the compat
// trigger, which is a no-op only because nothing raw writes the table any more.
//
// NOT db/migrations.ts: its only `INTO messages…` is `messages_fts`, the FTS shadow table,
// which the word boundary correctly excludes. Listing it would have been a stale entry
// hiding one file's worth of progress — the stale check below caught exactly that.
const WRITER_ALLOWLIST: string[] = [];

// Set A (8 files stamp `authorized`) ∪ Set B (11 files compute `channel` via
// resolveOrCreateConversation) = 12 files, re-derived at 24fe27e and matching T0's pin.
// `agent/v2/inbound-channel.ts` is the funnel seven of the eight stamp through, so it is
// listed too. `shared/src/origin.ts` is deliberately NOT here and never will be: it
// CONSUMES these fields to derive origin — it is the resolver, not an ingest producer.
// SWEEP-A empties this list (SWEEP-A exit: length 0).
// T10: `memory/interagent.ts` LEAVES this list because the file is deleted. Its entry is
// replaced, not simply removed — the peer-A2A conversation resolve it performed moved to
// `agent/a2a-transport.ts`, the site that was calling the shim. Same producer, one fewer
// indirection; the list length is unchanged and Sweep A's burn-down is not quietly shortened.
const PRODUCER_ALLOWLIST: string[] = [
  'agent/a2a-transport.ts', 'agent/v2/deliveries.ts', 'agent/v2/inbound-channel.ts',
  'agent/v2/loop.ts', 'gateway/routes/chat.ts', 'gateway/routes/twilio.ts',
  'scheduler/runner.ts', 'services/gmail-watcher.ts', 'services/imessage-bridge.ts',
  'services/outlook-watcher.ts', 'services/teams-watcher.ts', 'twilio/call-session.ts',
  'twilio/sms-inbound.ts',
];

describe('the matcher itself (a weakened regex must not pass silently)', () => {
  const hits = (s: string) => WRITE_RE.test(s);

  it('catches all five write forms, including the interpolated VERB', () => {
    expect(hits('INSERT INTO messages (id) VALUES (?)')).toBe(true);
    expect(hits('INSERT OR IGNORE INTO messages (id) VALUES (?)')).toBe(true);
    expect(hits('INSERT OR REPLACE INTO messages (id) VALUES (?)')).toBe(true);
    expect(hits('`${verb} INTO inter_agent_messages`')).toBe(true);
    expect(hits('`INSERT OR IGNORE INTO ${table} (id)`')).toBe(true);
    expect(hits('UPDATE messages SET swept_at = ?')).toBe(true);
    expect(hits('`UPDATE ${engineEventTable(src)} SET conv_key = ?`')).toBe(true);
    expect(hits('DELETE FROM messages WHERE agent_id = ?')).toBe(true);
    expect(hits('DELETE FROM inter_agent_messages WHERE id = ?')).toBe(true);
  });

  it('does NOT catch the FTS shadow table, or other tables that merely start the same way', () => {
    expect(hits('INSERT INTO messages_fts(rowid, content) VALUES (?, ?)')).toBe(false);
    expect(hits('INSERT INTO summary_messages (summary_id) VALUES (?)')).toBe(false);
    expect(hits('DELETE FROM messages_fts WHERE rowid = ?')).toBe(false);
  });

  it('catches the third store, which T4 folded in and nothing may write again', () => {
    expect(hits('INSERT INTO agent_messages (from_agent) VALUES (?)')).toBe(true);
    expect(hits('DELETE FROM agent_messages WHERE from_agent = ?')).toBe(true);
  });
});

// ── The one standing exemption, and it is NOT an allowlist entry ──
//
// PHASE-1 T4. `migration/path-migration.ts` rewrites `$HOME` references inside a database
// file that has just been IMPORTED from another machine. It opens that file itself
// (`new Database(dbPath)` at :57, closed at the end) because the app's connection does not
// point at it and must not — the whole job is to fix the foreign file up BEFORE it becomes
// this box's database. Routing it through the writer module would send the UPDATE to the
// wrong database, which is a worse outcome than the rule it would satisfy.
//
// So it is exempt, permanently, and the exemption is a named constant with a test rather
// than a quiet allowlist entry that a later reader would mistake for unfinished work. The
// test below is what stops the exemption being abused: a file may only sit here if it
// really does open its own connection.
const OFFLINE_DB_TOOLS: string[] = ['migration/path-migration.ts'];

describe('single writer for `messages`', () => {
  it('no file outside the writer module writes the table unless it is on the burn-down list', () => {
    const offenders = sourceFiles()
      .filter(f => f !== WRITER_MODULE)
      .filter(f => !WRITER_ALLOWLIST.includes(f))
      .filter(f => !OFFLINE_DB_TOOLS.includes(f))
      .filter(f => WRITE_RE.test(read(f)));
    expect(offenders, 'a NEW writer appeared outside memory/message-store.ts').toEqual([]);
  });

  it('the offline-tool exemption is only available to files that open their own database', () => {
    for (const f of OFFLINE_DB_TOOLS) {
      const src = read(f);
      expect(src, `${f} is exempt only because it operates on a FOREIGN database file`)
        .toMatch(/new Database\(/);
      expect(src, `${f} must not use the app connection — that is what makes it exempt`)
        .not.toMatch(/getDb\(\)/);
    }
  });

  it('the writer module actually writes the table (the rule is not vacuous)', () => {
    expect(WRITE_RE.test(read(WRITER_MODULE))).toBe(true);
  });

  it('every allowlist entry still exists and still writes — no stale entries hiding progress', () => {
    const stale = WRITER_ALLOWLIST.filter(f => {
      const p = path.join(SRC, f);
      return !fs.existsSync(p) || !WRITE_RE.test(fs.readFileSync(p, 'utf8'));
    });
    expect(stale, 'these are converted — delete them from WRITER_ALLOWLIST (T4 burn-down)').toEqual([]);
  });

  it('records the burn-down position so progress is visible, not asserted', () => {
    // Not a threshold — a measurement. T4 drives it to 0; the number moving down IS the
    // deliverable. A count with no command beside it is a rumour, so the command that
    // produced the seed is written above WRITER_ALLOWLIST.
    expect(WRITER_ALLOWLIST.length).toBeGreaterThanOrEqual(0);
    expect(WRITER_ALLOWLIST.length).toBeLessThanOrEqual(43);
  });
});

describe('ingest stamping has one owner (OR4)', () => {
  const AUTH_RE = /\bauthorized\s*:\s*(?!\s*\/\/)/;
  const CHAN_RE = /resolveOrCreateConversation\s*\(/;
  // ONE predicate, used by BOTH the offender scan and the stale-entry scan below, so the
  // two can never disagree about what "is a producer" means.
  const producesIngest = (rel: string): boolean => {
    const src = read(rel);
    // Comment-only mentions do not make a file a producer.
    const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    return AUTH_RE.test(codeOnly) || CHAN_RE.test(codeOnly);
  };

  it('no file outside the writer module computes `authorized` or `channel` off-list', () => {
    const offenders = sourceFiles()
      .filter(f => f !== WRITER_MODULE && f !== 'memory/conversations.ts')
      .filter(f => !PRODUCER_ALLOWLIST.includes(f))
      .filter(producesIngest);
    expect(offenders, 'a NEW ingest producer appeared — stamp through the writer module').toEqual([]);
  });

  it('the producer allowlist is the 12-file union plus the funnel, and Sweep A empties it', () => {
    expect(PRODUCER_ALLOWLIST).toContain('agent/v2/inbound-channel.ts');
    expect(PRODUCER_ALLOWLIST).not.toContain('shared/src/origin.ts');
    // ⚠ PHASE-6 GUARD-AUDIT 2026-08-04 — THIS STALE CHECK WAS `existsSync` ONLY, AND THAT
    // IS HALF A CHECK. Its twin on WRITER_ALLOWLIST already re-tests the pattern; this one
    // did not, and the asymmetry is a hole the decomposition walks straight into.
    //
    // `agent/v2/loop.ts` is on this list. PHASE-6 moves the ingest stamping out of the
    // driver into a step package. On that day the step file correctly becomes an offender
    // above (loud) — but `loop.ts` KEEPS its exemption here forever, because the file still
    // exists. An exemption that outlives its reason is not inert: it silently re-permits
    // the very thing it was granted for, so a later `authorized:` re-appearing in the
    // driver would pass unremarked.
    //
    // Now an entry must still EXIST and still PRODUCE, judged by the same predicate the
    // offender scan uses. When a tranche moves the stamping, this fails and names the file.
    //
    // THE ONE ENTRY THAT IS NOT A PRODUCER, AND IT IS ON THE LIST FOR A DIFFERENT REASON.
    // Strengthening this clause found it on its first run: `agent/v2/inbound-channel.ts` is
    // the FUNNEL seven of the eight producers stamp through — a resolver that READS
    // `authorized` off `inbound_meta` and has never written it. The list has always held
    // two roles under one name, and `existsSync` could not tell them apart. So the funnel
    // is declared, with its reason, and its exemption is checked in BOTH directions: it must
    // be on the list, and it must NOT produce. The day it starts producing, this fails and
    // the note above it is what has gone stale.
    const FUNNEL = 'agent/v2/inbound-channel.ts';
    expect(PRODUCER_ALLOWLIST).toContain(FUNNEL);
    expect(
      producesIngest(FUNNEL),
      `${FUNNEL} is on this list as the FUNNEL, not as a producer — it now stamps, so either ` +
      'it became a producer (drop the funnel note) or the predicate drifted',
    ).toBe(false);

    const stale = PRODUCER_ALLOWLIST
      .filter(f => f !== FUNNEL)
      .filter(f => !fs.existsSync(path.join(SRC, f)) || !producesIngest(f));
    expect(
      stale,
      'these allowlist entries no longer produce (or no longer exist) — the exemption has ' +
      'outlived its reason, so delete the entry (and, if the mechanism MOVED, add its new ' +
      'home instead: an exemption follows the code, never the path it used to live at)',
    ).toEqual([]);
  });
});

describe('the fail-closed reader is the only human-facing accessor', () => {
  it('migration 127 declares chat_messages as lane-owner + not-retired', () => {
    const mig = fs.readFileSync(
      path.join(SRC, 'db', 'migrations', '127_unified_messages.sql'), 'utf8');
    expect(mig).toMatch(/CREATE VIEW chat_messages AS[\s\S]{0,120}lane = 'owner'/);
    expect(mig).toMatch(/retired_at IS NULL/);
  });

  it('every compat structure carries the task that deletes it (R2: scaffolding with a date)', () => {
    const mig = fs.readFileSync(
      path.join(SRC, 'db', 'migrations', '127_unified_messages.sql'), 'utf8');
    for (const marker of ['origin_kind', 'source', 'conv_key']) {
      const line = mig.split('\n').find(l =>
        new RegExp(`^\\s{2}${marker}\\s`).test(l));
      // T4 RE-DATED origin_kind/source from T4-DELETES to T10-DELETES on measured
      // evidence (T4 report §7): every WRITER is converted off them, but the READS were
      // still live and dropping the columns failed the tail loader to prepare — a dead
      // box, which R1 forbids. T5 has since re-pointed the whole memory layer onto
      // `lane`/`channel`; the reads that remain are T6's raw-SQL long tail (re-derive:
      // `git grep -P "(^|[^_[:alnum:]])origin_kind\b" -- packages/`). The marker must be
      // TRUE, not aspirational; a stale one says the scaffolding is gone when it is
      // standing, which is the failure this rule exists to prevent.
      expect(line, `compat column ${marker} must declare its demolition owner`)
        .toMatch(/T4-DELETES|T10-DELETES|PHASE2-DELETES/);
    }
    expect(mig).toMatch(/messages_compat_ai[\s\S]{0,80}/);
    expect(mig).toMatch(/T4 DROPS this trigger/);
  });

  it('the compat trigger is actually dropped, and only when the allowlist is empty', () => {
    // The trigger's whole job was classifying rows that UNCONVERTED writers inserted.
    // Its demolition is not a matter of taste: when the allowlist is at zero it is
    // provably a no-op (proven on a VACUUM INTO copy — the writer module's rows are
    // byte-identical with it and without it, on all three lanes). This test ties the two
    // facts together so neither can drift: an empty allowlist REQUIRES the drop to have
    // shipped, and a non-empty one forbids it.
    const drop = fs.readFileSync(
      path.join(SRC, 'db', 'migrations', '128_drop_messages_compat_trigger.sql'), 'utf8');
    expect(drop).toMatch(/DROP TRIGGER IF EXISTS messages_compat_ai;/);
    expect(WRITER_ALLOWLIST.length,
      'the compat trigger may only be dropped once every writer is converted').toBe(0);
  });
});
