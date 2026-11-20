-- Nothing reads or writes the drain ladders any more (the one clock and the request's own hand-back count
-- replace them), so their table goes. No view or trigger names it.
DROP TABLE IF EXISTS drain_state;
