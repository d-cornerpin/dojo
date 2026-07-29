-- 145_third_store_and_shown_flag.sql — PHASE-2 T10F: the THIRD message store goes (its two rows
-- rescued first, per D1's rider), and the flag with no writer goes with it.
--
-- ┌─ agent_messages ───────────────────────────────────────────────────────────────────────┐
-- │ VERDICT: STRIP.                                                                        │
-- │                                                                                        │
-- │ requirement preserved: an agent telling another agent a result — the sensei completion  │
-- │ reports (`message_type='result'`) Dreamer and Healer sent to the primary. It is a       │
-- │ `messages` row on `lane='a2a'` with `source_agent_id` naming the sender: Part III's      │
-- │ "THREE stores collapse, not two", finished here.                                        │
-- │                                                                                        │
-- │ evidence, re-derived at THIS head by command, across `packages/server/src`,              │
-- │ `packages/dashboard/src` AND `watchdog/`, excluding migrations:                          │
-- │   grep -rnaE "(FROM|INTO|UPDATE|JOIN|TABLE)[[:space:]]+agent_messages\b|DELETE FROM …"   │
-- │   -> 3 hits, and ZERO of them are production SQL: one comment in                         │
-- │   `memory/message-store.ts:947` recording the cascade this table used to need, and two   │
-- │   NEGATIVE-CONTROL LITERALS inside `single-writer-conformance.test.ts:146,147`. Those    │
-- │   two are the strongest form of this evidence: the writer-allowlist walk runs every      │
-- │   suite and FAILS if a production write against this table ever appears, so the zero is  │
-- │   ENFORCED rather than observed.                                                         │
-- │ nothing REFERENCES it: `sqlite_master … LIKE '%REFERENCES%agent_messages%'` -> empty.    │
-- │ this box: 2 rows — and they are why this is a rescue and not a bare drop.                │
-- └────────────────────────────────────────────────────────────────────────────────────────┘
--
-- ── THE D1 RIDER, HONOURED ──
--
-- PHASE-2 T0 wrote the condition and it is quoted here rather than paraphrased: "rescue its 2
-- rows into `messages` (lane `a2a`, `provenance='rescued'`) in the same migration that drops
-- it, or leave the table alone. **Do not drop it empty-handed.**"
--
-- THE MAPPING:
--   id                -> id            (carried; `messages.id` is UNIQUE, not the PK)
--   to_agent          -> agent_id      (whose timeline it belongs to)
--   from_agent        -> source_agent_id + sender_id   (the CHECK below needs the first)
--   content           -> content       (verbatim, byte for byte — the cache law: content is
--                                       written once and never rewritten)
--   created_at (TEXT) -> created_at + sent_at, epoch ms
--   lane              -> 'a2a', role 'user', display_kind 'a2a', display_tier 'agent-only'
--   provenance        -> 'rescued'
--
-- `metadata` IS NOT CARRIED, and that is a measurement rather than a trim. Both rows' metadata
-- is `{"status":…,"summary":…,"stats":{tokensUsed,cost,durationSeconds,toolCallsCount}}` and
-- every one of those values is ALREADY RESTATED IN `content`, in prose, in the same row
-- ("...completed with status: complete / Summary: … / Stats: 5 messages, 630 tokens, $0.0650
-- cost, … 1 tool calls"). There is no column on `messages` whose meaning is "a sender's own
-- JSON" — `inbound_meta` is CHANNEL metadata and putting agent stats there would be a lie about
-- what that column means — and inventing one to hold a duplicate would be this phase's own
-- disease. `read_by_recipient` is 0 on both rows and has no reader anywhere.
--
-- ⚠ THE ROWS ARE RESCUED AS HISTORY, NOT AS TRAFFIC — and this clause exists because of a trap
-- this phase has already been bitten by once. T9's bucket-B conv-key work found that 14
-- pre-112 notices WOULD HAVE RE-DELIVERED on the owner's body when their rows became visible
-- to a live reader again. These two rows are 2026-07-27 sensei reports that have been inert in
-- a table nothing reads; making them look FRESH to the assembler would surface two-day-old
-- Dreamer and Healer summaries into a live agent's context as if they had just arrived.
--
-- So `swept_at` and `retired_at` are stamped at the rescue instant:
--   * `swept_at` is what every drain and lifecycle read tests for ("has something already
--     handled this"), so no sweep can claim them;
--   * `retired_at` is display suppression only (07§2g), so no renderer surfaces them.
-- Neither is a new mechanism and neither invents a threshold. `served_by_turn` is deliberately
-- left NULL: no turn served them, and stamping a turn number that never existed would be
-- manufacturing a fact — the same call RULING 7 made when it refused to backfill checksums.
-- The record becomes QUERYABLE, which it was not; it does not become an obligation.
--
-- The `lane='a2a'` CHECK (`role IN ('assistant','tool') OR source_agent_id IS NOT NULL`) is
-- satisfied by `source_agent_id`, which is the honest value: these are INBOUND peer rows and
-- T3-0b requires an inbound peer row to name its sender.
--
--
-- ┌─ work.deliverable_shown ───────────────────────────────────────────────────────────────┐
-- │ VERDICT: STRIP.                                                                        │
-- │                                                                                        │
-- │ requirement preserved: DELIVERED WORK IS NEVER SILENTLY REGENERATED — and it is         │
-- │ preserved by a mechanism that already exists and already has a test.                    │
-- │ `tracker/tools.ts:retaskWouldOverwriteDeliveredWork` is a pure predicate over FOUR       │
-- │ facts, of which this column is only the first, and the other three are live:             │
-- │   2. `complete` and no authority has upheld it (`adjudications`, via `validatedExpr`)    │
-- │   3. a worker's close request filed with the row not moved (`pendingCloseRequestExpr`,   │
-- │      migration `139`'s two-key trigger)                                                 │
-- │ T8c converted the guard to that predicate SPECIFICALLY so this column could go, and      │
-- │ wrote the consequence down in place: "when T10 drops the column the ONLY change is that  │
-- │ `deliverableShown` is always false: the second disjunct, the escape hatch and every      │
-- │ clause about them keep their meaning."                                                   │
-- │                                                                                          │
-- │ THE GUARD TEST EXISTS AND BITES: `tracker/__tests__/retask-delivered-work-backstop.test  │
-- │ .ts`, 14 clauses covering BOTH branches and the `allow_regenerate` escape hatch. That     │
-- │ test is the condition the plan's own STOP set ("the guard's requirement is CONVERTED TO   │
-- │ A TEST before the column goes — or the column stays"), and it is discharged.              │
-- │                                                                                          │
-- │ evidence: 15 mentions across the three trees, of which THREE are code and all three are   │
-- │ the same read in one function (`tracker/tools.ts:3075` the SELECT, `:3077` its type,      │
-- │ `:3093` the field handed to the predicate) plus one entry in a patchable-column union     │
-- │ (`work/tracker-store.ts:165`). Every other mention is a comment describing the deleted    │
-- │ writer. NO PRODUCTION WRITER HAS EXISTED since the P2 drive boundary, and                 │
-- │ `tracker/tools.ts:186` has said so in the tree since T8c: "remains as read-only legacy    │
-- │ data for rows stamped before this release; no writer exists."                             │
-- │                                                                                          │
-- │ this box, re-derived: 610 `work` rows, **0** with `deliverable_shown = 1`. T8c2 measured   │
-- │ 0 of 586; it is 0 of 610 now, so the flag is a FORWARD guard only and always was on this  │
-- │ box. The row count is NOT the verdict (#15) — the enumeration above is.                   │
-- │                                                                                          │
-- │ ⚠ AND TWO GREEN CONFORMANCE TESTS ASSERT THIS COLUMN'S WRITER IS GONE, which means they   │
-- │ break when the column does. PINNED §12 named them in advance so they would be RETIRED     │
-- │ DELIBERATELY rather than discovered: `two-key-conformance.test.ts` and                    │
-- │ `serve-boundary-conformance.test.ts`. They are re-expressed in the same commit as this    │
-- │ file, never deleted — the clause that mattered (no writer, no stand-down redirect) is      │
-- │ asserted against the column's ABSENCE, which is strictly stronger than asserting nobody   │
-- │ writes a column that exists.                                                              │
-- └────────────────────────────────────────────────────────────────────────────────────────┘
--
-- No index, trigger or view mentions `deliverable_shown` (`SELECT type,name FROM sqlite_master
-- WHERE sql LIKE '%deliverable_shown%'` returns the `work` TABLE and nothing else), so
-- `ALTER TABLE … DROP COLUMN` is available and no table rebuild is owed.
--
-- ── RE-RUNNABLE: NO, for the same reason `143` is not ──
-- SQLite has no `DROP COLUMN IF EXISTS`, so a manual second apply fails at step 3. Safe because
-- `applyOne` records the migration name inside the same transaction as the apply: a crash rolls
-- back all three steps together and a retry does the whole thing once. A manual re-run failing
-- loudly is the right direction after MAP-TRIAGE. (Step 1's rescue is independently idempotent
-- via `INSERT OR IGNORE`, so the ORDER of failure is also safe.)
--
-- Destructive: YES, deliberately. On a lived-in box the `agent_messages` rows are carried by
-- `135b_stable_work_spine.sql`, which sorts strictly before this file; the same ordering
-- argument as Bridge Entries 13, 16, 17 and 18.

-- ── 1. Rescue the third store's rows into the one message table ───────────────────────────

INSERT OR IGNORE INTO messages (
  id, agent_id, lane, role, content, display_kind, display_tier,
  source_agent_id, sender_id, authorized,
  swept_at, retired_at, provenance, sent_at, created_at
)
SELECT
  am.id,
  am.to_agent,
  'a2a',
  'user',                      -- inbound to `to_agent`; direction is carried by `role`
  am.content,
  'a2a',
  'agent-only',                -- fail-closed: visibility is EARNED, and agent traffic never
                               -- masquerades as owner chat (OR4)
  am.from_agent,
  am.from_agent,
  0,                           -- not owner-authorized, and never was
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,   -- see "HISTORY, NOT TRAFFIC" above
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  'rescued',
  CAST(strftime('%s', am.created_at) AS INTEGER) * 1000,
  CAST(strftime('%s', am.created_at) AS INTEGER) * 1000
FROM agent_messages am
JOIN agents a ON a.id = am.to_agent      -- agent_id REFERENCES agents(id): a row for an agent
JOIN agents f ON f.id = am.from_agent    -- that no longer exists cannot be carried
WHERE am.created_at IS NOT NULL
  AND CAST(strftime('%s', am.created_at) AS INTEGER) * 1000 > 1600000000000;

-- ── 2. The third store goes ───────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS agent_messages;

-- ── 3. And the flag whose writer went at the drive boundary ───────────────────────────────

ALTER TABLE work DROP COLUMN deliverable_shown;
