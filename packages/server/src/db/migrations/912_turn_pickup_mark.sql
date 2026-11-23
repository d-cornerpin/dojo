-- The last message row that existed when the turn picked up its work: what the turn could be shown. NULL before 912.
ALTER TABLE turns ADD COLUMN pickup_seq INTEGER;
