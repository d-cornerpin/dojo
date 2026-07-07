-- FA-VO6(a): the voice turn-taking patience dial (voice.vad_sensitivity) had no
-- seeded row, so an unset box diverged silently. The dashboard's Voice tab shows
-- 'quick' by default while the server's getTurnPatience() used to fall back to
-- 'normal'. The server default is now 'quick' to match; this seeds the config
-- row so the stored state is explicit and the pair can never drift apart again.
--
-- INSERT OR IGNORE: only seeds when absent, so a box where the owner already
-- chose 'normal' or 'patient' keeps that choice. Idempotent (re-running is a
-- no-op after the first pass).
INSERT OR IGNORE INTO config (key, value, updated_at)
VALUES ('voice.vad_sensitivity', 'quick', datetime('now'));
