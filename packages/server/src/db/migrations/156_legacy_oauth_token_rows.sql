-- 156 (PHASE-5 T10 / owner decision D2): DELETE THE LEGACY DUPLICATE OAUTH TOKEN
-- ROWS FROM `config`.
--
-- ⚠ THE COST THE OWNER ACCEPTED, STATED HERE BECAUSE THIS FILE IS WHERE IT IS
-- SPENT. Migration 071's header promises that the legacy per-key storage is
-- "left in place during the transition so the old path keeps working and
-- rollback is trivial." These eight rows ARE that promise. Deleting them ends
-- it: after this migration a build older than 071's account tables can no longer
-- recover a Google or Microsoft connection from `config`, and reconnecting means
-- re-authorising the accounts by hand. That was put to the owner as ONE question
-- together with encrypting the live columns (T10/D1) — both end the same path, so
-- asking twice would have been asking the same thing twice — and he chose to end
-- it. This migration is not free and does not pretend to be.
--
-- ── WHAT IS DELETED, AND WHAT IS DELIBERATELY NOT ──
-- ONLY the eight token values:
--     gws_access_token       gws_refresh_token
--     gws_user_access_token  gws_user_refresh_token
--     ms_access_token        ms_refresh_token
--     ms_user_access_token   ms_user_refresh_token
-- The other legacy `gws_*` / `ms_*` keys STAY. That is not caution, it is
-- measurement: two live reader families outside the seed read `gws_connected`,
-- `gws_account_email` and `ms_connected` as fallbacks — `migration/checks.ts`
-- (the reconnect decision) and `migration/manifest.ts` (the export manifest an
-- old package is read with). They read no token. Taking the whole legacy block
-- would have broken two readers to solve a problem only the tokens have.
--
-- ── THE ONE THING THAT READS THESE EIGHT KEYS, RE-DERIVED AT THIS HEAD ──
-- `seedGoogleAccountsFromConfig` / `seedMicrosoftAccountsFromConfig`, and NOTHING
-- else. They are invisible to a per-key grep because the key names are built at
-- runtime from a prefix switch (`cfg(`${p}access_token`)`), which is why the
-- enumeration was done by reading the seed rather than by grepping the names:
-- 31 of the 37 legacy keys have zero literal occurrences anywhere in the tree.
-- The seeds have exactly two call sites, both in `index.ts` at boot.
--
-- ── THE GUARD, AND WHY IT IS THE EXACT COMPLEMENT OF THE SEED'S OWN ──
-- The seed's first line is `if (getPrimaryGoogleAccount(kind)) continue;` — it
-- skips a kind that already has an account row and NEVER LOOKS AT THE LEGACY KEYS
-- FOR THAT KIND AGAIN. So for a kind that has a row, these keys are unreachable,
-- and deleting them removes a duplicate.
--
-- For a kind that has NO row, the seed still reads them, and they are not a
-- duplicate — THEY ARE THE ONLY COPY. That body is real: a box that has never
-- booted a build carrying migration 071 has legacy keys and no account rows, and
-- migrations run BEFORE the seed does. An unguarded DELETE here would destroy the
-- account on the very boot that was supposed to migrate it, and the user would
-- see Google and Microsoft simply gone.
--
-- Hence: each pair is deleted only when its kind's account row EXISTS. Rehearsal
-- decided this shape (roadmap #16) — the unguarded version was written first and
-- planted against a seeded body, where it took the sole copy exactly as described.
--
-- ── THE POST-CONDITION IS A REFUSAL, NOT A COMMENT ──
-- The final block records which of the eight keys existed BEFORE the deletes and
-- then refuses to commit if any of them is gone while its kind has no account row
-- — i.e. if a sole copy was destroyed. It is written against the recorded
-- pre-state rather than against absence, because "the key is not there" is also
-- what a fresh install looks like, and a migration that aborts the chain on a
-- fresh install aborts the BOOT (the `.23` / `135` incident class).
-- Strip the guards from the four DELETEs and this block throws on that body;
-- `__tests__/migration-156-legacy-oauth-tokens.test.ts` drives exactly that
-- counterfactual, plus a clean body, a fresh install, and a mixed body.

-- (0) The pre-state: which of the eight token keys this database actually has.
CREATE TEMP TABLE t156_before AS
  SELECT key FROM config
   WHERE key IN ('gws_access_token', 'gws_refresh_token',
                 'gws_user_access_token', 'gws_user_refresh_token',
                 'ms_access_token', 'ms_refresh_token',
                 'ms_user_access_token', 'ms_user_refresh_token');

-- (1)-(4) The guarded deletes: a pair goes only when its kind is already seeded.
DELETE FROM config
 WHERE key IN ('gws_access_token', 'gws_refresh_token')
   AND EXISTS (SELECT 1 FROM google_accounts WHERE kind = 'agent');

DELETE FROM config
 WHERE key IN ('gws_user_access_token', 'gws_user_refresh_token')
   AND EXISTS (SELECT 1 FROM google_accounts WHERE kind = 'user');

DELETE FROM config
 WHERE key IN ('ms_access_token', 'ms_refresh_token')
   AND EXISTS (SELECT 1 FROM microsoft_accounts WHERE kind = 'agent');

DELETE FROM config
 WHERE key IN ('ms_user_access_token', 'ms_user_refresh_token')
   AND EXISTS (SELECT 1 FROM microsoft_accounts WHERE kind = 'user');

-- (5) The refusal. `ok` can only ever be 1; a 0 aborts the migration, which
--     aborts the chain, which is the loudest thing a migration can do.
CREATE TEMP TABLE t156_assert (
  ok INTEGER NOT NULL
    CONSTRAINT migration_156_would_have_deleted_the_only_copy_of_a_sign_in_token
    CHECK (ok = 1)
);

INSERT INTO t156_assert (ok)
SELECT CASE WHEN EXISTS (
  SELECT 1
    FROM t156_before b
   WHERE NOT EXISTS (SELECT 1 FROM config c WHERE c.key = b.key)   -- it is gone
     AND NOT EXISTS (                                              -- with nothing to justify it
       SELECT 1 FROM google_accounts
        WHERE kind = 'agent' AND b.key IN ('gws_access_token', 'gws_refresh_token')
       UNION ALL
       SELECT 1 FROM google_accounts
        WHERE kind = 'user' AND b.key IN ('gws_user_access_token', 'gws_user_refresh_token')
       UNION ALL
       SELECT 1 FROM microsoft_accounts
        WHERE kind = 'agent' AND b.key IN ('ms_access_token', 'ms_refresh_token')
       UNION ALL
       SELECT 1 FROM microsoft_accounts
        WHERE kind = 'user' AND b.key IN ('ms_user_access_token', 'ms_user_refresh_token')
     )
) THEN 0 ELSE 1 END;

DROP TABLE t156_assert;
DROP TABLE t156_before;
