-- 120: root lineage on router decisions (lanes & lineage P6b). request_id
-- (mig 116) joins a decision to the spend it produced; these carry WHY the
-- call happened, same root vocabulary as every other lineage row.
ALTER TABLE router_log ADD COLUMN root_kind TEXT;
ALTER TABLE router_log ADD COLUMN root_id TEXT;
