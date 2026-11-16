-- A reply waiting to go out is its own deliveries row: what to send and where, how many tries it has had, and
-- when the next one is due (ms since the epoch). Only rows with a payload are ever picked up by the sender.
ALTER TABLE deliveries ADD COLUMN payload_json TEXT;
ALTER TABLE deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN next_attempt_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(next_attempt_at)
  WHERE outcome = 'pending' AND payload_json IS NOT NULL;

-- An earlier version's pending row is a send that died inside its transport; nothing will finish it now.
UPDATE deliveries
   SET outcome = 'failed',
       detail = 'left unresolved by an earlier version; whether it reached the person is not known: ' || COALESCE(detail, ''),
       updated_at = datetime('now')
 WHERE outcome = 'pending';
