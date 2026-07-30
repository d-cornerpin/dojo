-- ════════════════════════════════════════════════════════════════════════════════════════
-- 147 — `messages.conversation_id` IS BACKFILLED FROM `messages.conv_key`.  PHASE-2 T10I,
--       RULING 11.  This file writes no DDL and drops nothing: it fills NULLs only.
--
-- verdict: REKEY (the identity half; the claim half was discharged at T10H).
-- requirement preserved: WHICH CONVERSATION EACH MESSAGE BELONGS TO. Nine readers scope on
--   that fact today — conversation-scoped recall (`memory/recall.ts`), the three assembler
--   scopers that stop one counterparty's settled work bleeding into another's turn (the
--   re-answer ghost, owner transcripts 2026-07-07/09), the active-directive pin
--   (`memory/directive.ts`), the answered-in-this-conversation edge, the re-answer guard's
--   "a DIFFERENT conversation" test, the F9 sibling batch-claim, the recently-answered
--   block, and the dashboard's background-row test. After this file they can read the fact
--   off `conversation_id`, which is a real FK into a real table, instead of off a composite
--   string that also carried three engine sentinels.
--
-- ── WHY A BACKFILL AND NOT A RENAME (T10H's blocker, and the number that reverses it) ──
--
-- T10H measured `conv_key = conversation_id` as STRINGS and found ZERO agreement on the 883
-- rows carrying both, and concluded "different keyspaces". The string comparison is the
-- wrong instrument: one side is `owner` / `imessage:+1555…` / `a2a:<thread>` and the other
-- is a uuid, so zero was the only possible answer and it says nothing about whether the two
-- name the same conversation.
--
-- The right instrument is `conversations`' own
-- `UNIQUE(agent_id, channel, provider, counterparty_id, thread_root)`, resolved exactly the
-- way each producer resolves it (`memory/conversations.ts:resolveOrCreateConversation`, read
-- at all eleven call sites rather than guessed). Measured that way, on the rows the PRODUCERS
-- THEMSELVES stamped — the only rows where an independent right answer already exists:
--
--     dev box (146)          823 reproduced   0 CONTRADICTED   62 abstained (of 885)
--     pre-127 real (146)     251 reproduced   0 CONTRADICTED   12 abstained (of 263)
--
-- Zero contradictions on two bodies. The keyspaces are not incompatible; they are the same
-- fact in two spellings, and the mapping below is the dictionary.
--
-- A second derivation was measured AND REFUSED: an own-output row could instead inherit the
-- conversation of its turn's trigger (`turns.source_message_id` -> that row's
-- `conversation_id`). It is REJECTED on its own numbers — it cannot be verified at all
-- (every producer-stamped row is a `role='user'` row inserted before its turn exists, so it
-- has no `turn_number` and the route abstains on all 885 of them), it CONFLICTS with the
-- route below on 6 rows with no way to adjudicate, and it happily assigns a conversation to
-- 24 `engine-steer` RIDER rows, which are not in a conversation at all. An unverifiable rule
-- that disagrees with a verified one is not a fallback.
--
-- ── THE DICTIONARY (each line read off the producer that writes it) ──
--
--   'owner'            -> (agent, channel IN ('dashboard','voice'), provider NULL,
--                          counterparty 'owner', thread_root NULL)
--                         `conversationKey()` maps dashboard, voice AND a null channel all
--                         to the single string 'owner'; `gateway/routes/chat.ts:130`,
--                         `agent/v2/deliveries.ts:71`, `scheduler/runner.ts:409` and
--                         `agent/v2/loop.ts:1632` all resolve that identity.
--   'a2a:<thread>'     -> (agent, 'a2a', thread_root = <thread>)
--                         `agent/a2a-transport.ts:983`. The peer's own id is part of the
--                         unique key and NOT part of `conv_key`, so two peers on one thread
--                         root make this ambiguous — and the count guard below refuses it.
--   '<channel>:<who>'  -> (agent, channel, counterparty_id = <who>)
--                         imessage / sms / phone / email / teams. `<who>` is lower-cased on
--                         both sides already (`conversationKey()` lower-cases; the resolver
--                         does `.trim().toLowerCase()`), so the match is direct. Split on the
--                         FIRST colon only, exactly as `conversationKey` builds it — a
--                         counterparty containing a colon must fail to resolve rather than be
--                         silently truncated (planted and proven).
--
-- ── THE ROWS THAT RESOLVE TO NOTHING GET NULL, AND NULL IS THE ANSWER, NOT A GAP ──
--
-- Measured BEFORE this file was written, on three bodies. Four categories, and each one is a
-- reason rather than a leftover:
--
--   A. SENTINELS — `conv_key IN ('engine','engine-steer','engine-notice')`.
--      dev 330 · reference 0 · adversarial 1.
--      These are not conversations and never were: they are the fake keys T10H replaced,
--      written on `lane='events'` rows to keep an engine rider out of the pending-event
--      pool. `lane='events'` already says what they are. Filling them would be the
--      invention this ruling forbids, and it would put coordination traffic inside a human
--      conversation — the exact thing `agent/v2/deliveries.ts:70` refuses to do for the peer
--      lane, with its reason written at the site.
--
--   B. LEGACY SIGILS — bare `'a2a'` (T4's retired claim stamp), `park:%`, `relayed:%`.
--      dev 22 (all 22 already carry a producer-stamped `conversation_id`) · reference 7
--      (all 7 stamped) · adversarial 8. A dead namespace is not an identity.
--
--   C. RESOLVES TO NOTHING — the identity is real but `conversations` has no row for it.
--      dev 18 · reference 47 · adversarial 51.
--      On the dev box all 18 are harness-injected rows on throwaway peer agents (`channel`
--      NULL, `sender_id` NULL, content "You are a quiet peer agent used by the behavioral
--      test harness") — written by no door, so no producer ever resolved a conversation.
--      On the reference body the 47 are pre-P5 history: `conversations` did not exist before
--      migration 127, so an agent the owner talked to before it has no row.
--      **MINTING WAS CONSIDERED AND REFUSED.** `resolveOrCreateConversation` would produce
--      one deterministic row per agent here, and the live product WILL mint exactly that row
--      the next time the owner speaks to that agent — but a `conversations` row created by a
--      migration is identity this migration invented, with no door and no event behind it,
--      and RULING 11 says never. The consequence is measured rather than waved at: 40 of the
--      47 reference rows are own-output (`role IN ('assistant','tool')`), which the readers'
--      NULL branch keeps anyway; the remaining 7 are legacy `role='user'` rows that leave
--      the scoped recall of that one agent. That is the whole cost, it is on the reference
--      body only, and it closes forward the first time that agent takes an owner turn.
--
--   D. RESOLVES TO MORE THAN ONE — `conv_key` drops a field the unique key needs.
--      dev 16 (13 already stamped) · reference 6 (5 stamped) · adversarial 7.
--      `email:notifications@example.com` names 19 conversations on the dev box, one per mail
--      thread, because `thread_root` is in the unique key and not in `conv_key`. This is the
--      honest direction of the difference between the two columns: `conversation_id` is
--      STRICTLY more precise. Picking one of nineteen would be a guess wearing a fact's
--      clothes, so the count guard leaves them NULL.
--
-- The guard at the end of this file is not documentation — it ABORTS the migration if any
-- row is left NULL for a reason not in that list. Migrations run inside a transaction
-- (`db/migrations.ts:165`), so an abort rolls the whole file back.
-- ════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. resolve every candidate, and COUNT the matches ──
-- The count is the whole safety property: a scalar subquery in SQLite silently returns the
-- FIRST of several rows, which is precisely how a backfill invents identity. Resolving into
-- a table with `count(*)` beside the id makes "exactly one" a condition instead of a hope.
DROP TABLE IF EXISTS _mig147_resolve;
CREATE TEMP TABLE _mig147_resolve AS
SELECT m.seq        AS seq,
       min(c.id)    AS conv_id,
       count(*)     AS n_matches
  FROM messages m
  JOIN conversations c
    ON c.agent_id = m.agent_id
   AND (
         -- 'owner': the one owner conversation per agent
         (m.conv_key = 'owner'
            AND c.channel IN ('dashboard','voice')
            AND c.provider IS NULL
            AND c.counterparty_id = 'owner'
            AND c.thread_root IS NULL)
         -- 'a2a:<thread root>'
      OR (m.conv_key LIKE 'a2a:%'
            AND c.channel = 'a2a'
            AND c.thread_root = substr(m.conv_key, 5))
         -- '<channel>:<counterparty>', split on the FIRST colon only
      OR (instr(m.conv_key, ':') > 1
            AND m.conv_key NOT LIKE 'a2a:%'
            AND c.channel         = substr(m.conv_key, 1, instr(m.conv_key, ':') - 1)
            AND c.counterparty_id = substr(m.conv_key, instr(m.conv_key, ':') + 1))
       )
 WHERE m.conv_key IS NOT NULL
   AND m.conversation_id IS NULL                -- fills NULLs; never overwrites a producer
   AND m.conv_key <> ''
   AND m.conv_key NOT IN ('engine','engine-steer','engine-notice','a2a')
   AND m.conv_key NOT LIKE 'park:%'
   AND m.conv_key NOT LIKE 'relayed:%'
 GROUP BY m.seq;

CREATE INDEX _mig147_resolve_idx ON _mig147_resolve(seq);

-- ── 2. the backfill: exactly-one matches only ──
UPDATE messages
   SET conversation_id = (SELECT r.conv_id FROM _mig147_resolve r WHERE r.seq = messages.seq)
 WHERE seq IN (SELECT seq FROM _mig147_resolve WHERE n_matches = 1);

-- ── 3. the guard — every surviving NULL must be one of the four named categories ──
-- A `CHECK` on a temp table is the abort: the INSERT below fails, the transaction rolls
-- back, and the migration reports the count of rows that escaped the taxonomy.
DROP TABLE IF EXISTS _mig147_guard;
CREATE TEMP TABLE _mig147_guard (
  unexplained_null_rows INTEGER NOT NULL
    CHECK (unexplained_null_rows = 0)          -- migration 147: a conv_key row left NULL for
);                                             -- a reason outside categories A–D

INSERT INTO _mig147_guard (unexplained_null_rows)
SELECT count(*) FROM messages m
 WHERE m.conv_key IS NOT NULL
   AND m.conversation_id IS NULL
   -- A: sentinels
   AND m.conv_key NOT IN ('engine','engine-steer','engine-notice')
   -- B: legacy sigils
   AND m.conv_key <> 'a2a'
   AND m.conv_key NOT LIKE 'park:%'
   AND m.conv_key NOT LIKE 'relayed:%'
   AND m.conv_key <> ''
   -- C: resolves to nothing  /  D: resolves to more than one
   AND (SELECT count(*) FROM conversations c
         WHERE c.agent_id = m.agent_id
           AND ( (m.conv_key = 'owner'
                    AND c.channel IN ('dashboard','voice') AND c.provider IS NULL
                    AND c.counterparty_id = 'owner' AND c.thread_root IS NULL)
              OR (m.conv_key LIKE 'a2a:%'
                    AND c.channel = 'a2a' AND c.thread_root = substr(m.conv_key, 5))
              OR (instr(m.conv_key, ':') > 1 AND m.conv_key NOT LIKE 'a2a:%'
                    AND c.channel         = substr(m.conv_key, 1, instr(m.conv_key, ':') - 1)
                    AND c.counterparty_id = substr(m.conv_key, instr(m.conv_key, ':') + 1)) )
       ) = 1;

DROP TABLE _mig147_guard;
DROP TABLE _mig147_resolve;
