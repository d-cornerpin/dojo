-- Healer proposals: require structured evidence pointers.
--
-- Pre-fix the healer could write a confident-sounding `description` /
-- `proposed_fix` with no traceable backing — including fabricated vault
-- IDs and "known platform bug" references. The dashboard surfaced these
-- to the user as if they were real, leading at least one operator to
-- nearly approve a fix that would have broken a working dispatcher.
--
-- Adding `evidence_json` (a JSON array of short bullet strings) and
-- making it part of the healer_propose tool's required input. Existing
-- rows stay NULL; the tool now refuses to write new rows without it.

ALTER TABLE healer_proposals ADD COLUMN evidence_json TEXT;
