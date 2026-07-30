-- ══════════════════════════════════════════════════════════════════════════════════════
-- 900_stable_upgrade_day_reconcile.sql — THE STABLE BRIDGE, last file in the chain.
-- Part V: "pre-baseline work rows stamped reconciled so first boot fires zero wakes."
-- Runs AFTER the whole local chain because 137 rewrites the columns it reads and 144
-- creates rows after that. Entry 9's 9xx rule, used for the first time.
-- Transcribed byte-faithful from ../STABLE-BRIDGE.md Entry 27 by SHIP-PREP, 2026-07-30.
-- GUARD 1 REMOVED. DEVIATION: scratch teardown at the end (see 126b's header).
-- ══════════════════════════════════════════════════════════════════════════════════════

-- ── 1. Overdue migrated schedules take the platform's OWN missed-runs pause. ──────────
--    Idempotent: is_paused = 0 in the WHERE, so a second apply is a no-op.
UPDATE work
   SET is_paused             = 1,
       schedule_status       = 'paused',
       missed_runs_paused_at = (unixepoch('now') * 1000)
 WHERE provenance IN ('migrated','rescued')
   AND kind = 'task' AND root_kind IN ('legacy','tracker','engine_scaffold')
   AND schedule_status = 'waiting'
   AND is_paused = 0
   AND next_run_at IS NOT NULL
   AND next_run_at <= (unixepoch('now') * 1000);

-- ── 2. The zero-wake assertions, re-checked HERE because 137/144 have now run. ────────
CREATE TEMP TABLE _bridge_assert (name TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK (ok = 1), detail TEXT);
INSERT INTO _bridge_assert (name, ok, detail) VALUES
  ('no_migrated_ask',
   (SELECT count(*) FROM work WHERE provenance IN ('migrated','rescued') AND kind='ask') = 0,
   'a migrated row must never be an ask: the boot staleness sweep can neither serve nor suppress it'),
  ('no_migrated_wake',
   (SELECT count(*) FROM work WHERE provenance IN ('migrated','rescued')
     AND (wakes <> 0 OR ttl_at IS NOT NULL OR next_attempt_at IS NOT NULL
          OR remaining_children IS NOT NULL)) = 0,
   'wakes/ttl/retry/countdown must all be inert on a migrated row'),
  ('due_scan_empty',
   (SELECT count(*) FROM work w
     WHERE w.kind='task' AND w.root_kind IN ('legacy','tracker','engine_scaffold')
       AND w.next_run_at <= (unixepoch('now') * 1000)
       AND w.schedule_status = 'waiting' AND w.is_paused = 0
       AND w.provenance IN ('migrated','rescued')) = 0,
   'the scheduler due-scan must return no migrated row on first boot'),
  ('done_has_delivery',
   (SELECT count(*) FROM work WHERE state='done' AND result_delivery_id IS NULL) = 0,
   'the phase constraint, re-checked after every file that writes work'),
  ('delivery_ids_resolve',
   (SELECT count(*) FROM work w WHERE w.result_delivery_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id = w.result_delivery_id)) = 0,
   'a CHECK cannot see resolution; transition() G7 can, and refuses later'),
  ('paired_nullability',
   (SELECT count(*) FROM work
     WHERE (state IN ('done','failed','abandoned')) <> (closed_at IS NOT NULL)) = 0,
   'closed_at and terminality agree on every row, migrated or not'),
  -- REPORTED, never asserted: the PM's queue on upgrade day. Bounded at LIMIT 10/sweep.
  ('pm_validation_backlog_reported', 1,
   'migrated done tasks awaiting a verdict: ' ||
   (SELECT count(*) FROM work w WHERE w.provenance='migrated' AND w.kind='task'
     AND w.root_kind IN ('legacy','tracker','engine_scaffold') AND w.state='done'
     AND NOT EXISTS (SELECT 1 FROM adjudications a
                      WHERE a.work_id = w.id AND a.claim_state='done' AND a.verdict='upheld'))),
  ('schedules_reconciled_reported', 1,
   'schedules paused by this file: ' ||
   (SELECT count(*) FROM work WHERE provenance IN ('migrated','rescued')
     AND schedule_status='paused' AND missed_runs_paused_at IS NOT NULL));

-- ── 3. Scratch teardown. ───────────────────────────────────────────────────────────────
DROP TABLE _bridge_assert;
