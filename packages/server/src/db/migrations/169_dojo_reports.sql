-- 169 (DOJO-REPORT T2): A PROBLEM REPORT HAS A ROW, BECAUSE ITS APPROVAL MUST BE ATOMIC.
--
-- WHY A TABLE AT ALL, when the evidence lives on disk. The bundle is a blob nobody queries and
-- it stays on disk (`~/.dojo/reports/<id>/bundle.json`, the receipts convention). What is HERE is
-- the part that is a state machine: drafting -> awaiting_approval -> approved -> posted. Owner
-- ruling D4 makes the preview card the ONLY door to posting and requires a FRESH approval per
-- post, which means `approved` must be reachable exactly once and must be consumed by the poster.
-- That is a conditional UPDATE inside a transaction. `destructive_approvals` + `consumeApproval`
-- already solved the identical problem in this tree; a JSON file with an atomic rename would be
-- a second, worse copy of it in the one place this feature cannot afford to be wrong.
--
-- WHY `brief_json` AND `telemetry_json` ARE HERE AND THE BUNDLE IS NOT. These two are exactly
-- what the card renders and exactly what gets posted, so they must be readable in the same query
-- that reads the status. They are also small and bounded. The raw bundle is neither, and it is
-- the one artefact D1 says never leaves the box - keeping it out of the database keeps it out of
-- every backup, every export and every `VACUUM INTO` rehearsal copy, which is a privacy property,
-- not a size optimisation.
--
-- WHY NO CHECK ON `status`. The legal set lives once, in `report/store.ts`'s `ReportStatus`, and
-- both the writer and every reader enforce it from there. A CHECK here would be a second, staler
-- copy - and the reader must survive a value this schema never approved (a hand-edited DB, a
-- restored backup, a future writer), which it does by treating an unknown status as terminal and
-- refusing to post, not by trusting a constraint to have held.
--
-- WHY NO FOREIGN KEY ON `agent_id`. Same rider the work spine took (135, PART 0 rider 1): an
-- agent can be deleted, and a report about what that agent hit is still a true record of what
-- this platform did. ON DELETE CASCADE would erase the evidence for the failure most worth
-- reporting, and RESTRICT would make deleting an agent fail. The column is the agent that FILED
-- it, not a live link.
--
-- SAFE ON A LIVED-IN BODY BY CONSTRUCTION: `CREATE TABLE IF NOT EXISTS` on a name that appears
-- nowhere in the 171-file chain. No column is added to an existing table, no row is read, written
-- or deleted, nothing is backfilled. A stable box arrives with zero rows and is correct: it has
-- filed no reports.
--
-- NEXT-RELEASE AUDIT NOTE: `dojo_reports` has exactly one writer module
-- (`packages/server/src/report/store.ts`) and three readers - that module, the preview-card routes
-- (`gateway/routes/reports.ts`) and the poster (`report/post.ts`). No agent-facing surface reads
-- it directly; the `dojo_report` tool reaches it only through `store.ts`.

CREATE TABLE IF NOT EXISTS dojo_reports (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'drafting',
  lane          TEXT NOT NULL,
  signature     TEXT NOT NULL,
  brief_json    TEXT,
  telemetry_json TEXT,
  bundle_path   TEXT,
  export_path   TEXT,
  issue_url     TEXT,
  issue_number  INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at   TEXT,
  posted_at     TEXT
);

-- The preview card's list is `WHERE status = ? ORDER BY created_at`; the dedupe search before a
-- post is `WHERE signature = ?`. Both are the whole read pattern this table has.
CREATE INDEX IF NOT EXISTS idx_dojo_reports_status ON dojo_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_dojo_reports_signature ON dojo_reports (signature);
