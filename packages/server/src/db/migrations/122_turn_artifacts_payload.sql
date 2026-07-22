-- 122: the attachment payload rides the artifact row (lanes & lineage P6b-2c).
-- turn_artifacts (mig 121) becomes the durable home of the pending-attachments
-- buffer; the full attachment descriptor (fileId/filename/mimeType/size/
-- category and flags) is JSON here so a drain can rebuild the assistant
-- message attachments exactly.
ALTER TABLE turn_artifacts ADD COLUMN payload_json TEXT;
