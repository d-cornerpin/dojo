-- Migration 064: add voice column to generation_jobs.
--
-- The audio (text-to-speech) generation kind carries an optional voice id
-- that the worker passes through to the provider. It lives in its own
-- migration (rather than in 063's CREATE TABLE) so dev DBs that already
-- applied the original voice-less 063 pick the column up here, while fresh
-- installs get 063 then this ALTER. Either path ends with the column
-- present exactly once. Null for image / music kinds.

ALTER TABLE generation_jobs ADD COLUMN voice TEXT;
