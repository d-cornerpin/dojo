-- 213 (v3.5 field fix 3, re-review 4): COMMANDS HANDED TO THE BACKGROUND, IN THE DATABASE.
--
-- When a person's message arrives during a long command, the exec door hands the call back and the
-- command keeps running as the agent's background job. Its result is promised to the agent. A Dojo
-- restart ends the command and breaks that promise, so each hand-off is recorded here while it runs
-- and removed once its result is saved for the agent; at boot, every row still here was cut by the
-- restart and its agent is told. It replaces `~/.dojo/data/background-commands.json` (re-review 3),
-- because SQLite is the Dojo's only datastore (architecture rule 5) and a row write is atomic.
-- New table only; nothing existing is changed.

CREATE TABLE IF NOT EXISTS background_commands (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  what        TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_background_commands_pid ON background_commands(pid);
