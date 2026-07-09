-- 103: D-A hotfix, summary_messages must accept two-homed message ids.
--
-- FOUND LIVE 2026-07-06 night: every compaction whose chunk contained an
-- inter-agent row failed with "FOREIGN KEY constraint failed" (createLeafSummary
-- -> dag.ts INSERT INTO summary_messages), because summary_messages.message_id
-- carried REFERENCES messages(id) from the single-table era. Since D-A,
-- inter-agent rows live in inter_agent_messages with their own ids, and the
-- merged fresh tail legitimately feeds them into compaction chunks. The failed
-- insert rolled back the whole leaf summary, the context never shrank, and
-- reactive compaction re-fired on every turn (the primary agent's observed
-- compaction loop).
--
-- Fix: rebuild the table WITHOUT the messages(id) foreign key. message_id is an
-- OPAQUE id that may live in EITHER messages or inter_agent_messages; consumers
-- that need bodies resolve it through the merged by-id lookup
-- (memory/dag.ts getMessagesByIds). The summaries(id) reference stays (summary
-- ids are single-homed). The PM prune's manual link-row cascade
-- (tracker/pm-agent.ts) is unaffected: it deletes link rows explicitly and never
-- relied on the constraint.
--
-- SQLite cannot drop a constraint in place; standard rebuild (new table, copy,
-- drop, rename). The copy preserves every existing mapping row.
--
-- IDEMPOTENCE GUARD (added post-ship, defense in depth): the CREATE below is
-- bare, so a mid-file abort that left a `summary_messages_new` skeleton behind
-- would make a re-run die on "table already exists". The runner now applies each
-- migration inside ONE transaction (apply+record atomic), which already closes
-- the partial-apply window; this leading DROP IF EXISTS is a belt-and-suspenders
-- guard that is valid SQL and harmless. Editing an ALREADY-SHIPPED migration is
-- normally forbidden, but this edit is safe: it ONLY adds an idempotence guard and
-- changes no applied semantics, and every box that already recorded 103 in
-- _migrations never re-runs it, so nothing re-executes on upgraded boxes.
DROP TABLE IF EXISTS summary_messages_new;

CREATE TABLE summary_messages_new (
  summary_id TEXT NOT NULL REFERENCES summaries(id),
  message_id TEXT NOT NULL,
  PRIMARY KEY (summary_id, message_id)
);

INSERT INTO summary_messages_new (summary_id, message_id)
  SELECT summary_id, message_id FROM summary_messages;

DROP TABLE summary_messages;

ALTER TABLE summary_messages_new RENAME TO summary_messages;
