-- ══════════════════════════════════════════════════════════════════════════════════════
-- 150_token_count_canonical.sql — PHASE-3 T2 Step 3b: one dialect in `messages.token_count`.
--
-- ── THE DEFECT, MEASURED ON A LIVE `.24` BODY ─────────────────────────────────────────
-- `token_count` is the number the assembler's `budgetFreshTail` spends as the INPUT cost of
-- carrying a row. Three different things have been written into it (PHASE-3 §T0-D):
--
--   1  ceil(len/4), floor 1     `memory/message-store.ts` — the live writer, correct
--   2  MAX(1, len/4) TRUNCATING migration 127's backfill + its compat trigger + 129b's
--                               stable-merge inserts. One token low, per row.
--   3  the provider's OUTPUT count for the WHOLE TURN — `agent/v2/loop.ts:5381/:5436/:7550`
--                               passed `result.outputTokens` into this column. Not an
--                               estimate of the stored bytes at all: it counts the model's
--                               text PLUS its tool JSON PLUS its reasoning, and it lands on
--                               the one row that holds only the text.
--
-- Dialect 3 is not a rounding difference, it is a UNIT ERROR, and it is almost exactly the
-- assistant lane. Measured readonly on the dev body at HEAD:
--
--   SELECT SUM(token_count), SUM(MAX(1,(LENGTH(content)+3)/4)) FROM messages
--     role='assistant'  ->  852,464 stored vs 262,949 true   = 3.24x over
--     whole store       ->  2,169,951 vs 1,584,829           = +36.9%
--
-- The consequence is user-visible on the owner's shipped build: the assembler believes the
-- fresh tail costs 37% more than it does, so it drops history the window did not require —
-- an agent that "forgets" things still inside its own budget.
--
-- ── WHAT THIS FILE DOES, AND WHAT IT REFUSES TO TOUCH ─────────────────────────────────
-- ONE UPDATE, over every row, to the canonical estimator: ceil(len/4) with a floor of 1.
--
-- CACHE LAW (OR7 / roadmap #10), and it is the reason this is safe at all: `content` is
-- written ONCE and never rewritten (`memory/message-store.ts:22-25` states it). This file
-- touches ONE non-content column. It does not touch `content`, `created_at`, `sent_at`,
-- `seq`, `id`, or any ordering — so not one historical prompt byte moves and no provider's
-- cached prefix is disturbed. A backfill that rewrote bytes would be a cache-law violation
-- dressed as a data fix.
--
-- WHY THE WRITE PATH IS FIXED FIRST, IN CODE, NOT HERE. `tokenCount` was REMOVED from
-- `NewMessage` in the same task (commit `cc5014b`). Without that, dialect 3 returns on the
-- next assistant turn and this file becomes a thing somebody has to re-run forever.
--
-- ── THE 127 COMPAT TRIGGER: ALREADY GONE, AND NOT BY ANYBODY'S DECISION ───────────────
-- The plan asked this step to "retire or re-derive migration 127:229-230's compat trigger,
-- which is still writing the truncating dialect onto 101 live rows". Re-derived before
-- acting (#14): the trigger does NOT exist. `SELECT name FROM sqlite_master WHERE
-- type='trigger' AND tbl_name='messages'` returns the four FTS triggers and nothing else.
-- `messages_compat_ai` died at migration `133`, which rebuilds the table and re-creates
-- only the FTS four — a silent side effect nobody recorded. The 101 rows are the residue of
-- the 7h19m window in which it was alive on this box (127 applied 2026-07-28 01:54:13,
-- 133 at 09:13:52; all 101 rows are stamped inside it). They are re-computed below like
-- every other row, so the residue ends here rather than being chased.
--
-- ── THE ONE RESIDUE THIS FILE CANNOT CLOSE, STATED RATHER THAN HIDDEN ─────────────────
-- SQLite's `LENGTH(text)` counts CODE POINTS; JavaScript's `.length` counts UTF-16 units.
-- They differ for astral characters (emoji), so a row containing one is estimated one unit
-- short here relative to what the live writer would produce. Measured over all 12,029 rows:
-- 20 rows have a differing length at all, and only 4 rows land on a different TOKEN count.
-- Sub-token noise on 0.03% of rows, named because an unnamed 4 is how a 4 becomes a 400.
-- ══════════════════════════════════════════════════════════════════════════════════════

-- ── 1. The backfill. Unconditional by design: every row, one dialect, no exceptions. ──
--    A `WHERE token_count <> …` guard would be faster and would also leave anybody reading
--    this file unable to say what the column means afterwards.
UPDATE messages
   SET token_count = MAX(1, (LENGTH(content) + 3) / 4);

-- ── 2. Prove it, in the transaction that did it. ─────────────────────────────────────
--    The runner wraps each file in its own transaction, so a failed assert rolls the whole
--    UPDATE back rather than leaving the column half-converted.
CREATE TEMP TABLE _tc_assert (name TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK (ok = 1), detail TEXT);
INSERT INTO _tc_assert (name, ok, detail) VALUES
  ('one_dialect',
   (SELECT count(*) FROM messages WHERE token_count <> MAX(1, (LENGTH(content) + 3) / 4)) = 0,
   'every row must equal the canonical estimator after this file'),
  ('no_zero',
   (SELECT count(*) FROM messages WHERE token_count < 1) = 0,
   'a row that costs nothing to carry does not exist — the floor of 1 is the writer''s own rule'),
  ('no_null',
   (SELECT count(*) FROM messages WHERE token_count IS NULL) = 0,
   'NULL would send every reader down the ?? fallback and re-open the fork this file closes');
DROP TABLE _tc_assert;
