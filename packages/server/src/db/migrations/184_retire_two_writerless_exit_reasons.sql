-- 184 (t113 C, ORCHESTRATOR RULING ledgered 2026-10-06): TWO WORDS THAT NAME EVENTS THAT
-- CANNOT HAPPEN LEAVE THE VOCABULARY.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- WHAT IS BEING RETIRED, AND WHAT IS EMPHATICALLY NOT
-- ════════════════════════════════════════════════════════════════════════════════════════
--
-- RETIRED: two members of the `turns.exit_reason` vocabulary — `delegation_exit` and
-- `compile_pending`. The enum in `agent/v2/turn-record.ts`, the CHECK below, and the telemetry
-- whitelist are the three places they were declared, and no production code has ever written
-- either one.
--
-- ⚠ NOT RETIRED, AND IT SHARES ONE OF THE NAMES: `work.compile_pending`, the INTEGER column
-- migration 135 created. That column is live, load-bearing and heavily read — the owed-compile
-- gate (`agent/v2/compile-owed-gate.ts`), the fan-out join's state machine and the relay path
-- all turn on it. A reader who greps the word finds both and must not conflate them: one is a
-- column recording that a compile is owed, the other was a word for why a turn ended. This
-- migration touches only `turns.exit_reason`'s CHECK. Nothing in `work` is read or written here.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- WHY RETIRE RATHER THAN WIRE — AND WHY THAT WAS A RULING AND NOT A WORKER'S CALL
-- ════════════════════════════════════════════════════════════════════════════════════════
--
-- t93 set out to give all the declared exit reasons their writers and found TEN unwired words,
-- not the eight its brief named. Eight got writers. These two did not, and t93 deliberately
-- declined to wire them, with the argument (its §7.1):
--
--   Both are MODEL dispositions, and neither is in `ENGINE_IMPOSED_EXITS`. So wiring them
--   changes what the anti-repetition ladder CHARGES, not merely what the record says. The
--   obvious site for `delegation_exit` — the delegation-send async exit at
--   `steps/execute/delegation-exit.ts:162` — is a turn that records `park` today, and `park`
--   IS engine-imposed. Moving it would start spending rungs on every delegating turn.
--
-- That is a behaviour change nobody ordered, which is why t93 held it for a ruling instead of
-- taking it. The ruling: RETIRE. A vocabulary that names events which cannot happen is the
-- dishonest-record family — the same disease as a status that claims a send that never
-- happened. Every reader of this enum is entitled to assume each member is a thing that occurs.
--
-- Either word can come back the day somebody defines the event that writes it AND rules on what
-- the ladder should charge for it. Retiring is cheap to reverse; a word that means nothing is
-- not cheap to keep, because every reader pays to find out it means nothing.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- WHY A TABLE REBUILD, AND WHAT HAPPENS TO A ROW CARRYING A RETIRED WORD
-- ════════════════════════════════════════════════════════════════════════════════════════
--
-- SQLite cannot ALTER a CHECK constraint, so narrowing one is a rebuild. This is the same
-- twelve-column shape migration 135 created, with two names removed from one `IN` list and
-- nothing else changed — the column list, the paired-nullability CHECK, the primary key and all
-- three indexes are reproduced exactly.
--
-- A row carrying a retired word becomes `'unknown'`. Three reasons, in order:
--   1. There should be none. The words are writerless, so on any real box this CASE touches
--      ZERO rows — and the G13 rehearsal plants them anyway, because "should be none" is a
--      claim about code and a migration runs against data.
--   2. `'unknown'` is this enum's declared quarantine value, and using it here is not an
--      invention: migration 135's own backfill vocabulary maps the old `error` outcome to
--      `'unknown'` with the reasoning "that is what we can honestly say".
--   3. The alternative — refuse to migrate when such a row exists — would brick an upgrade on a
--      box whose row we cannot explain, over a word no code can have written. Under the
--      update-integrity standard an update never fails. The COUNT is what gets recorded, in the
--      verification query below, so a non-zero result is visible rather than silent.
--
-- The retired words are NOT mapped to `park` or to anything meaningful, deliberately: inventing
-- a specific reason for a row whose history we cannot read is manufacturing a distinction, which
-- is the exact mistake 135's comment warns against for `provider_error`.

-- ── THE REBUILD ──
-- `turns` has no inbound foreign keys (checked: no `REFERENCES turns` anywhere in the tree), so
-- the drop-and-rename needs no FK ordering care.

-- ⚠ NOTE ON THE COMMENT PLACEMENT BELOW, which is a real trap and not a style preference.
-- SQLite stores the CREATE TABLE text VERBATIM in `sqlite_master.sql`, comments included. The
-- first draft of this migration put "minus `delegation_exit` and `compile_pending`" INSIDE the
-- CREATE, and the rehearsal's own verification query — which asks the live schema whether either
-- word still appears — then reported both as still present. The CHECK was correct; the comment
-- was what matched. Any future census that greps the live schema for a retired word would have
-- been misled the same way, so every mention of the retired names stays ABOVE the statement and
-- out of the stored bytes. (The same G4 lesson as a source-matching clause reading the prose
-- above the call, in SQL instead of TypeScript.)
--
-- The vocabulary in the CHECK below is the 135 list minus those two: 15 values, down from 17.

CREATE TABLE turns_184 (
  agent_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  kind TEXT,
  subject_kind TEXT,
  subject_id TEXT,
  root_kind TEXT,
  root_id TEXT,
  source_message_id TEXT,
  conv_key TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN (
      'answered','no_reply_intended','park','handoff','iteration_cap',
      'brake','identical_call','stop','preempt','provider_error','stream_idle','abort',
      'terminated','budget','unknown')),
  answered INTEGER NOT NULL CHECK (answered IN (0,1)),
  effectful_calls INTEGER NOT NULL DEFAULT 0,
  answer_message_id TEXT,
  lane TEXT,
  PRIMARY KEY (agent_id, turn_number),
  CHECK ((ended_at IS NULL) = (exit_reason IS NULL))
);

INSERT INTO turns_184 (
  agent_id, turn_number, kind, subject_kind, subject_id, root_kind, root_id,
  source_message_id, conv_key, started_at, ended_at, exit_reason, answered,
  effectful_calls, answer_message_id, lane
)
SELECT
  agent_id, turn_number, kind, subject_kind, subject_id, root_kind, root_id,
  source_message_id, conv_key, started_at, ended_at,
  -- The two retired words DO appear here, and that is fine: this is an INSERT, and SQLite
  -- stores only CREATE text in `sqlite_master`. A rewrite has to name what it rewrites.
  -- `CASE x WHEN NULL` can never match, so NULL rides the ELSE and stays NULL — which the
  -- paired CHECK requires of an open turn.
  CASE exit_reason
    WHEN 'delegation_exit' THEN 'unknown'
    WHEN 'compile_pending' THEN 'unknown'
    ELSE exit_reason
  END,
  answered, effectful_calls, answer_message_id, lane
FROM turns;

DROP TABLE turns;
ALTER TABLE turns_184 RENAME TO turns;

-- All three indexes 135 created, reproduced exactly. A rebuild that drops an index is a
-- performance regression nothing would notice until a slow query showed up months later.
CREATE INDEX idx_turns_root ON turns(root_id) WHERE root_id IS NOT NULL;
CREATE INDEX idx_turns_subject ON turns(agent_id, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX ix_turns_open ON turns(agent_id) WHERE ended_at IS NULL;
