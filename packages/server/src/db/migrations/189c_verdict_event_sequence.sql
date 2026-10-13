-- 189c (v3.3.3 t142): A VERDICT IS POSITIONED ON THE work_events SEQUENCE, NOT ON A CLOCK.
--
-- WHAT WAS WRONG. `work/tracker-view.ts:validatedExpr` decides `<state>_validated` by asking
-- whether an upheld adjudication is "at or after the row last entered that state", and it
-- answered that with `adjudications.created_at >= MAX(work_events.created_at)` — two CLOCK
-- readings, compared across two tables. `work_events` carries a SEQUENCE, and this codebase's
-- own written law (`work/override-requests.ts`) says ordering is by `work_events.id`, never by
-- `created_at`, because the platform has hit the same-millisecond defect three times. A block
-- the PM upheld, resolved forward and blocked AGAIN inside one millisecond read as UPHELD: the
-- board said so, the owner's escalation sentence said "Your PM checked it", and the disposal
-- door refused the assignee's own close-out. Driven RED in
-- `work/__tests__/t142-sequence-freshness.test.ts`.
--
-- WHY A COLUMN. An adjudication lives in its own table with its own autoincrement, so nothing
-- on the row says where it sits in the work's event history. It needs ONE fact: its place on
-- the `work_events` sequence. `event_seq` is that fact: the id of the verdict's COMPANION
-- event — every live writer files the adjudication and then, in the SAME transaction, appends
-- exactly one event for it (`transition()` -> the `transition` row; `upholdClaim` ->
-- `claim_upheld`; `rejectClaim` -> `claim_rejected`), and nothing in between. The reader then
-- asks a sequence question: `adj.event_seq >= <id of the last transition into the state>`.
--
-- WHY A TRIGGER AND NOT THE WRITERS. The three writers live outside this lane's fence, and a
-- stamp every writer must remember is the shape this codebase keeps having to repair. The
-- trigger stamps every insert, by any writer present or future, with the id the NEXT
-- work_events row will receive — AUTOINCREMENT's own counter, `sqlite_sequence.seq + 1`, which
-- SQLite keeps at or above MAX(id) on every insert — and that is exactly the companion's id,
-- because the companion is the next row written.
--
-- ⚠ THE TRIGGER NAMES NO TABLE BUT sqlite_sequence, AND THAT IS LOAD-BEARING. SQLite >= 3.26
-- re-validates every trigger on `ALTER TABLE … RENAME`, and work_events gains a new kind by
-- exactly that move (159, 189: build work_events_new, DROP work_events, RENAME). A trigger body
-- that read `MAX(id) FROM work_events` — this file's first draft — made that RENAME fail with
-- "error in trigger …: no such table: main.work_events" on the product's SQLite (3.49.2), so
-- the NEXT migration to add an event kind would have failed on every box. Rehearsed in
-- `db/__tests__/t142-migration-189.test.ts` ("a future work_events rebuild still applies").
-- `work/__tests__/t142-sequence-freshness.test.ts` drives all three writers and asserts the
-- stamp equals the companion's real id, so a writer that ever slips an event in between
-- reds a clause instead of silently mis-ordering verdicts. A writer may also supply the value
-- itself (`WHEN NEW.event_seq IS NULL`).
--
-- THE BACKFILL, AND WHERE A CLOCK CANNOT BE MADE EXACT. Existing rows were written by the same
-- three writers, so each has a companion: an event on its work, at or after its own instant, of
-- the companion kind for its claim state. The UPDATE below takes the FIRST such event. When
-- several matching events share the verdict's millisecond, that can be EARLIER than the true
-- companion — never later, because the true companion is itself a candidate. So a backfilled
-- verdict can never leak forward into a later episode (the defect this migration exists to
-- end); the worst a same-millisecond history can do is position a verdict before an entry it
-- belonged to, which reads "unvalidated": the owner may be told, the board shows the claim
-- unchecked. A row with NO companion on file (no version of the product writes one; the
-- branch is a safety net) is placed at the end of the history it was filed into —
-- MAX(work_events.id) at migration time — which keeps today's answer for it and lets any later
-- re-entry outrank it. Every branch is rehearsed in `db/__tests__/t142-migration-189.test.ts`.
--
-- A CORRUPTED PAYLOAD CANNOT TAKE THE BOOT DOWN. `json_extract` RAISES on malformed JSON, and a
-- raise inside a migration aborts the whole chain. Every extract below is behind
-- `json_valid`, so an unreadable event is simply not a companion (rehearsed with one).
--
-- WHY "189c" AND NO "189b". This file was committed once as `189b_…` on its lane branch and then
-- amended there before it ever left the branch (the json_valid guard, and the trigger form argued above).
-- No box applied that first version, but `check-migration-freeze` cannot tell branch iteration
-- from an applied version, and its remedy (a KNOWN_DIVERGENCES entry) would record an
-- application that never happened. A fresh name has one version, which is the truth.
--
-- DOWNGRADE. An older build never reads `event_seq` and lists its INSERT columns explicitly,
-- so the column is inert to it; the trigger keeps stamping rows that build writes, so a later
-- re-upgrade reads them correctly.

ALTER TABLE adjudications ADD COLUMN event_seq INTEGER;

UPDATE adjudications
   SET event_seq = COALESCE(
     (SELECT MIN(e.id) FROM work_events e
       WHERE e.work_id = adjudications.work_id
         AND e.created_at >= adjudications.created_at
         AND (   (e.kind = 'transition'
                  AND CASE WHEN json_valid(e.payload)
                           THEN json_extract(e.payload, '$.to') END = adjudications.claim_state)
              OR (e.kind IN ('claim_upheld', 'claim_rejected')
                  AND CASE WHEN json_valid(e.payload)
                           THEN json_extract(e.payload, '$.claim_state') END = adjudications.claim_state))),
     (SELECT COALESCE(MAX(id), 0) FROM work_events))
 WHERE event_seq IS NULL;

DROP TRIGGER IF EXISTS adjudications_event_seq;

CREATE TRIGGER adjudications_event_seq
AFTER INSERT ON adjudications
WHEN NEW.event_seq IS NULL
BEGIN
  UPDATE adjudications
     SET event_seq = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'work_events'), 0) + 1
   WHERE id = NEW.id;
END;
