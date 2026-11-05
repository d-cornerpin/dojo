-- 212 (v3.5 field fix 3): THERE IS NO SUMMARY-WRITER SETTING. DELETE ITS ROW.
--
-- OWNER RULING, verbatim: "I was very clear that there was not to be a summarization/compaction model setting and
-- that each agents own model would do the compaction summarization." The t268 work kept the Settings "Summarization
-- Model" card and its key, `compaction_model_id`; this build removes the card, the route special case and every reader
-- (`memory/summary-writer-health.ts` `summaryWriterCandidates` now orders the agent's own model, then the Dojo's
-- small writer, and nothing else). A lived-in box may still carry the row an earlier build wrote; it is read by
-- nothing now, so it is deleted here, so the next auditor is not misled by it.
--
-- SAFE ON A LIVED-IN BODY: one DELETE of one key by equality (never a prefix or a LIKE), so no other row can move.
-- IDEMPOTENT: a second run matches no row. The keys derived from the old pick (`summary_writer_not_answering`,
-- `summary_span_refused`, `summary_unwritable` in `healer_state`) carried it as a key part; the readers now write and
-- match an empty part, and the existing prune drops rows under an earlier setting, so nothing here touches them.

DELETE FROM config WHERE key = 'compaction_model_id';
