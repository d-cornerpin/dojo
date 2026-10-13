-- 191 (t143, OR-LONG-JOBS): A LONG JOB IS LEFT ALONE; A BROKEN OR SILENT AGENT IS TOLD ONCE.
--
-- agents.silent_window_minutes   how long this agent may show NO movement at all (no tokens in or
--                                out, no request open on a live connection, no tool started or
--                                finished) before the owner is told it has gone silent. NULL means
--                                the owner-confirmed default, 2 hours. A per-agent setting so a
--                                known-slow agent can be given longer (owner, 2026-10-12).
-- agents.silent_notice           JSON `{ at, since, words, dismissedAt? }`: the SILENT incident the
--                                owner was told about (`since` = the last movement before it). The
--                                record decides the text, the dashboard card and the clear: it is
--                                cleared the moment the agent moves again.
-- agents.broken_notice           the same shape for BROKEN: a provider refused the agent in a way
--                                only the owner can fix (key, access, credit, network). Cleared when
--                                the agent next completes healthy work.
--
-- Additive only: no existing row changes, so every agent keeps the default window and nothing is
-- "already told" after the update.

ALTER TABLE agents ADD COLUMN silent_window_minutes INTEGER;
ALTER TABLE agents ADD COLUMN silent_notice TEXT;
ALTER TABLE agents ADD COLUMN broken_notice TEXT;
