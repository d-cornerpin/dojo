-- FA-R5: the router shadow probe is OFF by default and opt-in. The header and
-- isProbeEnabled default already say so; this seeds the config row to match for
-- existing boxes that never had one (where the old default read as implicit ON).
--
-- INSERT OR IGNORE: only seeds when absent, so a box where the owner explicitly
-- set 'true' keeps its opt-in. Turning probing back on is a one-row config write.
-- Idempotent: re-running has no effect after the first pass.
INSERT OR IGNORE INTO config (key, value, updated_at)
VALUES ('router_probe_enabled', 'false', datetime('now'));
