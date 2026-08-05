-- 158_ask_ledger_remediation.sql — SWEEP-A TB3: the ask ledger's existing bad records get
-- corrected, on every box that crosses this build.
--
-- ── WHAT IS BEING FIXED, AND WHY IT IS NOT A SCHEMA CHANGE ──
--
-- TB1 gave owner asks ONE settlement authority and TB2 taught it that a tool-call chip is not
-- an answer. Both are forward fixes: from that commit on, an answered ask closes with the
-- receipt that answered it and an unanswered one goes back to the person. Neither of them
-- touches a row that was already written wrong, and a lived-in database is full of them:
--
--   * asks stranded `claimed` by a turn that finished long ago — answered, never ticked off
--     (46 on the dev body at this migration's authoring, 38 of them with the delivery that
--     answered them sitting on the ledger the whole time);
--   * asks written off `abandoned` by the unservable-ask reaper AFTER they had been answered;
--   * `done` rows whose delegation never cleared its compile-pending flag (73 on the dev
--     body, and `compile_resolved` had been written ZERO times ever against them);
--   * `done` rows whose receipt is the model's own `tool_use` CHIP rather than a reply — 884
--     of 1,834 closed asks on the dev body, 48.2%.
--
-- Not one of those is a shape problem, so this file creates no table and alters no column.
-- The correction is a DECISION per row — "was this ask actually answered, and by what?" — and
-- that decision belongs to exactly one place: `work/ask-settlement.ts:settleAsk`, the
-- authority TB1 built. SQL cannot ask it. So this migration does the one thing SQL can do
-- honestly here: it RECORDS THE OBLIGATION, and the code discharges it on the next boot.
--
-- This is the same two-part shape migration `156` used for the sign-in tokens (Bridge Entry
-- 36): a numbered chain member that arms the work, plus a boot-time conversion that performs
-- it. The alternative — a hand-rolled SQL predicate that decides "answered" for itself —
-- would put a SECOND decider in the tree, and the entire two-bug arc exists to delete the
-- other three.
--
-- ── WHAT THE BOOT PASS DOES WITH THIS ROW ──
--
-- `work/ask-remediation.ts:runArmedAskRemediation()` reads this key at boot. If it says
-- `armed`, the pass runs and then OVERWRITES the value with its own JSON report — how many
-- rows it found in each class and what it did with each. If it says anything else, the pass
-- does nothing and says nothing. So:
--
--   * the correction happens exactly once per box, on the first boot after this migration;
--   * "did this box get the correction, and what did it find?" is answerable from the
--     database months later, by anybody, without reading a log that has rotated;
--   * `INSERT OR IGNORE` means re-applying the chain over a box that already ran the pass
--     does NOT re-arm it — the completion report is not overwritten by a second `armed`.
--
-- ── WHAT A LIVED-IN BOX WILL SEE ON UPGRADE DAY ──
--
-- Some of its old asks change state. Every one of those changes is a recorded transition with
-- its reason, and the history it corrects stays in `work_events` — nothing is deleted and
-- nothing is back-dated. Asks the ledger proves were answered close, pointing at the delivery
-- that answered them. Asks that were never actually answered are handed BACK to the person,
-- open and visible, because the owner's governing ruling for this arc is that ambiguity errs
-- toward serving the ask again and never toward a quiet close. The pass runs AFTER the boot
-- staleness sweep and BEFORE the re-drain, so the rows it hands back are served in the same
-- sitting rather than left for a later reboot to meet.
--
-- ── ROLLBACK ──
--
-- `DELETE FROM config WHERE key = 'ask_ledger_remediation_158';` — which un-arms an unrun
-- pass, or discards the report of one that ran. It does NOT undo the corrections: those are
-- recorded transitions on the work spine, and un-recording them is the forgery this spine
-- exists to refuse. A box that rolls back keeps the corrected ledger, which is the honest
-- state either way.

INSERT OR IGNORE INTO config (key, value, created_at, updated_at)
VALUES (
  'ask_ledger_remediation_158',
  'armed',
  datetime('now'),
  datetime('now')
);
