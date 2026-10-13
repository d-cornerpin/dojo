-- 193 (t138 rounds 3-4, ruling R-V333-13): AN OWNER CARD OUTLIVES THE PAGE.
--
-- Every text the platform sends the owner also shows as a dashboard card until he dismisses
-- it. The card is re-derived from the alert state the server already keeps — no new store —
-- so a dashboard that loads or reconnects shows it again. These columns let that state say
-- two more things, on the incident's own row:
--
--   budgets.alert_words           the words the owner was told at the latest crossing, so the
--                                 card says exactly what the text said.
--   budgets.alert_dismissed_at    unix second he dismissed that card; a NEW crossing clears it.
--   error_loop_state.owner_card_closed_at
--                                 epoch ms the paused-agent card for this trip ended: he
--                                 dismissed it, or the agent left 'paused' (a clean turn, a
--                                 manual resume). A new trip is a new row, so a new card.
--   google_accounts.owner_notice / microsoft_accounts.owner_notice
--                                 JSON `{ at, words, dismissedAt? }`: the "connection expired"
--                                 text he was told when the account was benched; cleared when
--                                 the sign-in is restored (round 4).
--   agents.rate_limit_notice      the same shape, for "rate-limited for <time>" (retries
--                                 exhausted); cleared when the agent leaves 'rate_limited'.
--
-- Additive only: no existing row changes. An agent paused by the error loop before this release
-- (and still paused) shows its card once after the update, which is the point: v3.3.2 never
-- texted it.

ALTER TABLE budgets ADD COLUMN alert_words TEXT;
ALTER TABLE budgets ADD COLUMN alert_dismissed_at INTEGER;
ALTER TABLE error_loop_state ADD COLUMN owner_card_closed_at INTEGER;
ALTER TABLE google_accounts ADD COLUMN owner_notice TEXT;
ALTER TABLE microsoft_accounts ADD COLUMN owner_notice TEXT;
ALTER TABLE agents ADD COLUMN rate_limit_notice TEXT;
