-- ══════════════════════════════════════════════════════════════════════════════════════
-- 135b_stable_work_spine.sql — THE STABLE BRIDGE, the work spine's lived-in remainder.
-- §§0–5 transcribed byte-faithful from ../STABLE-BRIDGE.md Entry 12 PART 2 ("THE SKELETON")
-- by SHIP-PREP, 2026-07-30. GUARD 1 REMOVED.
--
-- THREE DEVIATIONS, each forced and each recorded in the report:
--  (a) §6's assertion block did not exist as SQL. Entry 12 Part 2 enumerates 14 assertions
--      in PROSE and closes the fence with "(§6's assertion block … transcribed as
--      `_bridge_assert` rows)". They are authored below, one per prose item, numbered to
--      match the ledger's list. This is AUTHORING, not transcription.
--  (b) `_pre` gained four columns (`work_before`, `turns_before`, `turns_paired_bad`,
--      `loop_id_collisions`) because assertions 4, 8 and 10 compare against a pre-state the
--      ledger's `_pre` does not capture. A count with nothing to compare it to is decoration.
--  (c) scratch teardown at the end — see 126b's header for the measured reason.
-- ══════════════════════════════════════════════════════════════════════════════════════

-- ── 0. Pre-state, captured before anything moves; and the assertion table, created FIRST
--       so any section below can add a row to it (Entry 9's mechanism: the CHECK aborts).
CREATE TEMP TABLE _bridge_assert (name TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK (ok = 1), detail TEXT);
CREATE TEMP TABLE _pre AS
  SELECT (SELECT count(*) FROM open_loops
           WHERE conv_key='owner' OR conv_key LIKE 'imessage:%')            AS loops_carried,
         (SELECT count(*) FROM open_loops)                                  AS loops_total,
         (SELECT count(*) FROM poke_log
           WHERE EXISTS (SELECT 1 FROM work w WHERE w.id = poke_log.task_id)) AS pokes_carried,
         (SELECT count(*) FROM poke_log)                                    AS pokes_total,
         (SELECT count(*) FROM work_events WHERE kind='audit')              AS audit_events_before,
         -- deviation (b): the pre-state assertions 4, 8 and 10 need.
         (SELECT count(*) FROM work)                                        AS work_before,
         (SELECT count(*) FROM turns)                                       AS turns_before,
         (SELECT count(*) FROM turns
           WHERE (ended_at IS NULL) <> (exit_reason IS NULL))               AS turns_paired_bad,
         (SELECT count(*) FROM work w WHERE w.id IN
            (SELECT 'legacy-loop:' || l.id FROM open_loops l))              AS loop_id_collisions,
         (SELECT count(*) FROM work WHERE conversation_id IS NOT NULL)      AS conv_id_producers,
         (SELECT count(*) FROM legacy_tasks)                                AS legacy_tasks_n,
         (SELECT count(*) FROM legacy_projects)                             AS legacy_projects_n;

-- ── 1a. The sentinel delivery for any agent §1 settles. ONE mechanism, not two:
--        identical shape to 135:230-238, INSERT OR IGNORE because 135 minted most of them.
INSERT OR IGNORE INTO deliveries (
  id, agent_id, turn_number, tool, channel, recipient_id, recipient_display,
  conversation_id, root_kind, root_id, message_id, receipt_id, outcome, detail,
  created_at, updated_at)
SELECT DISTINCT
  'legacy-closure:' || l.agent_id, l.agent_id, NULL, 'legacy-closure', 'none', NULL, NULL,
  NULL, 'migration', '135b_stable_work_spine', NULL, NULL, 'migrated',
  'A pre-Bridge obligation was recorded as answered before the delivery ledger existed. '
  || 'outcome is ''migrated'', never ''delivered'': all four readers of this table filter '
  || 'outcome=''delivered'', so this can never be mistaken for delivery evidence.',
  datetime('now'), datetime('now')
  FROM open_loops l
 WHERE (l.conv_key='owner' OR l.conv_key LIKE 'imessage:%')
   AND l.status='resolved' AND l.answered_at IS NOT NULL;

-- ── 1b. open_loops -> work(kind='commitment'). Ids NAMESPACED (see the entry).
INSERT INTO work (
  id, kind, parent_id, agent_id, assignee_agent, requester, requester_id, conversation_id,
  root_kind, root_id, state, claimed_by_turn, result_delivery_id, intent, wakes,
  closes_thread, hop_count, superseded_by, title, goal, priority, notes, remaining_children,
  compile_pending, ttl_at, reply_conversation_id, attempts, next_attempt_at, schedule_json,
  tz, anchor_local, next_run_at, sequence, opened_at, closed_at, updated_at, provenance)
SELECT
  'legacy-loop:' || l.id, 'commitment', NULL,
  l.agent_id, NULL, 'owner', NULL,
  NULL,                                     -- §4 fills it, in this file
  'legacy', l.id,
  CASE WHEN l.status='resolved' AND l.answered_at IS NOT NULL THEN 'done'
       WHEN l.status IN ('resolved','stale')                  THEN 'abandoned'
       ELSE 'open' END,
  NULL,
  CASE WHEN l.status='resolved' AND l.answered_at IS NOT NULL
       THEN 'legacy-closure:' || l.agent_id END,
  'legacy', 0, 0, 0, NULL,
  l.description, NULL, NULL, NULL, NULL,
  0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL,
  MAX(COALESCE(CAST(strftime('%s', l.created_at) AS INTEGER) * 1000,
               CAST(strftime('%s', l.updated_at) AS INTEGER) * 1000,
               1600000000001), 1600000000001),
  CASE WHEN l.status IN ('resolved','stale')
       THEN MAX(COALESCE(CAST(strftime('%s', COALESCE(l.answered_at, l.updated_at)) AS INTEGER) * 1000,
                         1600000000001), 1600000000001) END,
  MAX(COALESCE(CAST(strftime('%s', l.updated_at) AS INTEGER) * 1000,
               1600000000001), 1600000000001),
  'migrated'
  FROM open_loops l
 WHERE (l.conv_key='owner' OR l.conv_key LIKE 'imessage:%')
   AND NOT EXISTS (SELECT 1 FROM work w WHERE w.id = 'legacy-loop:' || l.id);

-- ── 2/3. a2a_threads / a2a_replies / the park machine: NOTHING IS MAPPED.
--   Measured on the reference body: 0 `park:%` keys on either message store; 6
--   `join-piece:%` rows, all harness debris on a finished fan-out; a2a_threads survives
--   this phase (143 shrinks it, nothing drops it) so there is nothing to preserve, and
--   490 non-terminal threads would become 490 obligations nobody asked for.
--   THE RULE WAS KEPT AT ZERO ROWS, AND THAT WAS A MEASUREMENT WEARING AN INVARIANT'S
--   CLOTHES. 3.1.18 (UPDATE-INTEGRITY U0): a user took the .16 → .17 update with one agent
--   waiting on another, and `park_namespace_empty` aborted 135b, the chain and the boot —
--   permanently, because a park is consumed only by the running platform and the platform
--   could no longer run. `a2a-transport.ts` at .16 writes `park:<thread>` (and the fan-out
--   form `park:~<t1>|<t2>#<remaining>`) every time an agent delegates and waits, so the
--   count is normal product state, not a corruption. The chain already said so twelve files
--   later: `147_conversation_identity_backfill.sql` lists `park:%` among the LEGACY SIGILS
--   it skips. Nothing downstream needs the zero — `148` drops the column outright.
--   So the count is REPORTED (ok=1), exactly like its sibling below, and the open
--   delegations it counts are closed by `135c_stable_close_open_parks.sql` in the product's
--   own fail-closed vocabulary. The refusal MECHANISM is untouched: the other thirteen
--   assertions still abort on `CHECK (ok = 1)`.
INSERT INTO _bridge_assert (name, ok, detail) VALUES
  ('park_namespace_empty', 1,
   'park: keys found: ' || (SELECT count(*) FROM messages
                             WHERE conv_key LIKE 'park:%')),
  -- DEVIATION (d), FORCED AND MEASURED by SHIP-PREP's rehearsal 2026-07-30: the ledger reads
  -- this count `FROM inter_agent_messages`, and `133_drop_dead_stores_and_promote_seq.sql:114`
  -- DROPS that table — 133 sorts BEFORE 135b. Observed, not reasoned: the chain aborted at
  -- `135b_stable_work_spine.sql: no such table: inter_agent_messages`. That is not the
  -- release-position condition the CHAIN INDEX warns about; it is an unconditional failure on
  -- EVERY box, including a Stable box at 111. `messages` is the correct source: 129b folds the
  -- IA rows in and carries `conv_key` identically, and `messages.conv_key` survives until 148.
  -- Reads 0 rather than 6 on a body where 129b did not run; the row is REPORTED (ok=1), so it
  -- cannot fail either way.
  ('join_piece_population_reported', 1,
   'join-piece rows: ' || (SELECT count(*) FROM messages
                            WHERE conv_key LIKE 'join-piece:%'));

-- ── 4. conversation_id for the rows 135 left NULL. Reads legacy_tasks/legacy_projects
--       because work.origin_conv_key does not exist until 137, which sorts AFTER this file.
--       COUNT-GUARDED: a scalar subquery silently returns the first of several matches, and
--       9 agent names on the reference body resolve to more than one agent id.
CREATE TEMP TABLE _src_key (work_id TEXT PRIMARY KEY, agent_id TEXT, key TEXT);
INSERT INTO _src_key (work_id, agent_id, key)
  SELECT t.id, COALESCE(t.assigned_to, t.created_by), t.origin_conv_key
    FROM legacy_tasks t WHERE t.origin_conv_key IS NOT NULL;
INSERT INTO _src_key (work_id, agent_id, key)
  SELECT p.id, COALESCE((SELECT t2.assigned_to FROM legacy_tasks t2
                          WHERE t2.project_id = p.id AND t2.assigned_to IS NOT NULL
                          ORDER BY t2.created_at LIMIT 1), p.created_by), p.origin_conv_key
    FROM legacy_projects p WHERE p.origin_conv_key IS NOT NULL;
INSERT INTO _src_key (work_id, agent_id, key)
  SELECT 'legacy-loop:' || l.id, l.agent_id, l.conv_key
    FROM open_loops l WHERE (l.conv_key='owner' OR l.conv_key LIKE 'imessage:%');

CREATE TEMP TABLE _work_conv (work_id TEXT PRIMARY KEY, rung INTEGER, n INTEGER, conv_id TEXT);
-- rung 1 — `owner`
INSERT INTO _work_conv (work_id, rung, n, conv_id)
  SELECT s.work_id, 1,
         (SELECT count(*) FROM conversations c WHERE c.agent_id = s.agent_id
            AND c.channel IN ('dashboard','voice') AND c.provider IS NULL
            AND c.counterparty_id = 'owner' AND c.thread_root IS NULL),
         (SELECT c.id     FROM conversations c WHERE c.agent_id = s.agent_id
            AND c.channel IN ('dashboard','voice') AND c.provider IS NULL
            AND c.counterparty_id = 'owner' AND c.thread_root IS NULL)
    FROM _src_key s WHERE s.key = 'owner';
-- rung 2 — `a2a:<thread>`
INSERT INTO _work_conv (work_id, rung, n, conv_id)
  SELECT s.work_id, 2,
         (SELECT count(*) FROM conversations c WHERE c.agent_id = s.agent_id
            AND c.channel = 'a2a' AND c.thread_root = substr(s.key, 5)),
         (SELECT c.id     FROM conversations c WHERE c.agent_id = s.agent_id
            AND c.channel = 'a2a' AND c.thread_root = substr(s.key, 5))
    FROM _src_key s WHERE s.key LIKE 'a2a:%';
-- rung 3 — `<channel>:<who>`, split on the FIRST colon only
INSERT INTO _work_conv (work_id, rung, n, conv_id)
  SELECT s.work_id, 3,
         (SELECT count(*) FROM conversations c WHERE c.agent_id = s.agent_id
            AND c.channel = substr(s.key, 1, instr(s.key, ':') - 1)
            AND c.counterparty_id = substr(s.key, instr(s.key, ':') + 1)),
         (SELECT c.id     FROM conversations c WHERE c.agent_id = s.agent_id
            AND c.channel = substr(s.key, 1, instr(s.key, ':') - 1)
            AND c.counterparty_id = substr(s.key, instr(s.key, ':') + 1))
    FROM _src_key s
   WHERE instr(s.key, ':') > 0 AND s.key NOT LIKE 'a2a:%';

UPDATE work SET conversation_id = (SELECT x.conv_id FROM _work_conv x WHERE x.work_id = work.id)
 WHERE work.conversation_id IS NULL                          -- never overwrite a producer
   AND EXISTS (SELECT 1 FROM _work_conv x WHERE x.work_id = work.id AND x.n = 1);

-- ── 5. poke_log -> work_events. task_override_requests likewise (0 rows on both real
--       bodies; the rule is kept). task_log is NOT here — 146 owns it, and copying it
--       would double every carried audit line.
INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT p.task_id, 'poke',
       json_object('poke_number', p.poke_number, 'poke_type', p.poke_type,
                   'response_received', p.response_received, 'provenance', 'migrated'),
       COALESCE(p.agent_id, 'engine'),
       MAX(COALESCE(CAST(strftime('%s', p.sent_at) AS INTEGER) * 1000,
                    1600000000001), 1600000000001)
  FROM poke_log p
 WHERE EXISTS (SELECT 1 FROM work w WHERE w.id = p.task_id);

INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT r.task_id, 'override_request',
       json_object('requested_status', r.requested_status, 'justification', r.justification,
                   'status', r.status, 'resolved_by', r.resolved_by,
                   'resolved_reason', r.resolved_reason, 'provenance', 'migrated'),
       r.requested_by,
       MAX(COALESCE(CAST(strftime('%s', r.created_at) AS INTEGER) * 1000,
                    1600000000001), 1600000000001)
  FROM task_override_requests r
 WHERE EXISTS (SELECT 1 FROM work w WHERE w.id = r.task_id);

-- ── 6. THE ASSERTION BLOCK — deviation (a). One row per prose item in Entry 12 Part 2's
--       "IN-TRANSACTION ASSERTIONS 135b OWES", numbered to match that list.
INSERT INTO _bridge_assert (name, ok, detail) VALUES
  -- Part 1's four.
  ('1_legacy_twins_conserved',
   (SELECT legacy_tasks_n FROM _pre) = (SELECT count(*) FROM legacy_tasks)
   AND (SELECT legacy_projects_n FROM _pre) = (SELECT count(*) FROM legacy_projects),
   'this file must not touch legacy_tasks / legacy_projects at all'),
  ('2_work_tasks_match_legacy_tasks',
   (SELECT count(*) FROM work WHERE kind='task' AND provenance='migrated')
     = (SELECT legacy_tasks_n FROM _pre),
   'every legacy task became exactly one migrated work task (135 did it; asserted here)'),
  ('3_done_has_delivery',
   (SELECT count(*) FROM work WHERE state='done' AND result_delivery_id IS NULL) = 0,
   'the phase constraint'),
  ('4_turns_untouched',
   (SELECT count(*) FROM turns) = (SELECT turns_before FROM _pre)
   AND (SELECT count(*) FROM turns WHERE (ended_at IS NULL) <> (exit_reason IS NULL))
       = (SELECT turns_paired_bad FROM _pre),
   'this file writes no turn; the pairing CHECK is unchanged'),
  -- T12's additions.
  ('5_loops_conserved',
   (SELECT count(*) FROM work WHERE kind='commitment' AND provenance='migrated')
     = (SELECT loops_carried FROM _pre),
   'carried open_loops == migrated commitments'),
  ('6_loops_no_done_without_delivery',
   (SELECT count(*) FROM work w WHERE w.kind='commitment' AND w.provenance='migrated'
     AND (( w.state='done' AND w.result_delivery_id IS NULL)
       OR ( w.result_delivery_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id = w.result_delivery_id)))) = 0,
   'a CHECK cannot see resolution; transition() G7 can, and refuses later — fail here'),
  ('7_loops_paired_nullability',
   (SELECT count(*) FROM work WHERE kind='commitment' AND provenance='migrated'
     AND (state IN ('done','failed','abandoned')) <> (closed_at IS NOT NULL)) = 0,
   'name the row, not the constraint'),
  ('8_no_id_collision',
   (SELECT loop_id_collisions FROM _pre) = 0,
   'every legacy-loop: id was absent from work BEFORE the insert — a count cannot see a swap'),
  ('9_conversation_ids_resolve',
   (SELECT count(*) FROM work w WHERE w.conversation_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = w.conversation_id)) = 0
   AND (SELECT count(*) FROM work w JOIN _work_conv x ON x.work_id = w.id
         WHERE x.n <> 1 AND w.conversation_id = x.conv_id) = 0,
   'every fill names a real conversations row, and no fill was made where the count was not 1'),
  ('10_never_overwrote_a_producer',
   (SELECT count(*) FROM work WHERE conversation_id IS NOT NULL)
     >= (SELECT conv_id_producers FROM _pre),
   'the UPDATE carries `conversation_id IS NULL`; a producer''s value can only survive'),
  ('11_pokes_resolve',
   (SELECT count(*) FROM work_events e WHERE e.kind IN ('poke','override_request')
     AND NOT EXISTS (SELECT 1 FROM work w WHERE w.id = e.work_id)) = 0,
   'refused pokes are REPORTED, not asserted to zero: refused = '
   || ((SELECT pokes_total FROM _pre) - (SELECT pokes_carried FROM _pre))),
  ('12_no_task_log_touched',
   (SELECT count(*) FROM work_events WHERE kind='audit')
     = (SELECT audit_events_before FROM _pre),
   '146 owns task_log; a copy here would double every carried audit line'),
  ('13_zero_wake_surfaces',
   (SELECT count(*) FROM work WHERE provenance='migrated'
     AND (wakes <> 0 OR ttl_at IS NOT NULL OR next_attempt_at IS NOT NULL
          OR remaining_children IS NOT NULL OR kind='ask')) = 0,
   'first boot fires zero wakes — Part V'),
  ('14_opened_at_above_floor',
   (SELECT count(*) FROM work WHERE opened_at <= 1600000000000) = 0,
   'by clamp, not by luck'),
  -- §7's acceptable-losses disclosure, as numbers on the row rather than prose in a comment.
  ('7_losses_reported', 1,
   'open_loops dropped by the filter: ' || ((SELECT loops_total FROM _pre) - (SELECT loops_carried FROM _pre))
   || ' · poke_log rows naming a deleted task: ' || ((SELECT pokes_total FROM _pre) - (SELECT pokes_carried FROM _pre))
   || ' · work rows still without a conversation: ' || (SELECT count(*) FROM work WHERE conversation_id IS NULL));

-- ── Scratch teardown (deviation (c)). ──────────────────────────────────────────────────
DROP TABLE _work_conv;
DROP TABLE _src_key;
DROP TABLE _pre;
DROP TABLE _bridge_assert;
