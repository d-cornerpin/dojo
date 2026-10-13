-- 190 (t138, #8): BUDGET AND BALANCE ALERT LATCHES SET WHILE THE ALERT WAS MUTED ARE CLEARED, ONCE.
--
-- ── WHAT WENT WRONG ──
-- Up to v3.3.2 every budget crossing and every provider-balance warning was sent to the
-- owner-notice door at 'warning', which drops it before the phone, and the "already alerted"
-- latch was set anyway: `budgets.alert_50/75/90_sent` and the config rows
-- `openrouter_threshold_alerted` / `deepseek_threshold_alerted`. A latch is meant to record
-- "the owner was told about this crossing". On an upgraded box these record a crossing he was
-- never told about (tracker #8), and the code that now does tell him reads them as "already
-- told" — so a balance already under its line would stay silent until a top-up, and a budget
-- already over 90% until its rolling window drained.
--
-- ── WHAT IT DOES ──
-- Clears those latches once. The first check after the update then tells the owner the CURRENT
-- state, once: one text per budget at the highest threshold its spend has reached (every
-- threshold passed is latched again in the same check), one per provider still under its line.
-- From then on the latches are written only by code that actually sends the notice.
--
-- A NULL or stray latch value is reset too (`IS NOT 0` catches it). The columns are nullable;
-- v3.3.2 wrote 0 or 1, and from this release the code writes 0 or the unix second the owner was
-- told (one text per threshold per budget window, costs/budget.ts).
--
-- ── WHAT IT DOES NOT TOUCH ──
-- Budget limits, periods, warning thresholds, spend records, and every other config row.

DELETE FROM config
 WHERE key IN ('openrouter_threshold_alerted', 'deepseek_threshold_alerted');

UPDATE budgets
   SET alert_50_sent = 0, alert_75_sent = 0, alert_90_sent = 0
 WHERE alert_50_sent IS NOT 0 OR alert_75_sent IS NOT 0 OR alert_90_sent IS NOT 0;
