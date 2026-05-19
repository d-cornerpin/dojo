-- Tag the origin of each message so the dashboard can render a small
-- mic icon on voice-originated user bubbles. NULL = legacy / typed.
-- Voice path sets source='voice' when persisting the STT transcript.

ALTER TABLE messages ADD COLUMN source TEXT DEFAULT NULL;
