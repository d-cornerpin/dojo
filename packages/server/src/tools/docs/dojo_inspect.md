# dojo_inspect

Look at anything that happened in your own Dojo, read-only: what happened to a task, an agent, a turn or a time window; what any agent said; what the platform logged; how the Dojo is configured; what is in its database; and its own source code. It never changes anything. Passwords, keys and tokens are never shown: credential tables are refused and token-shaped text is blanked in every view.

Use it before any shell command about the Dojo: the shell refuses `sqlite3` reads of the Dojo's database and reads of its platform log, and names the dojo_inspect call that answers instead.

That shell check is a guard for the common commands, not a boundary — the grant is the boundary. It catches the usual `sqlite3`, `cat`, `grep` and `tail` forms and says which view answers; it does not try to read every possible shell script.

Who holds it: the main agent and the Healer. The owner, or the main agent, can give it to another agent by naming `dojo_inspect` in that agent's tools and the "Oversight & Admin" tool group in its grants; an agent that was given it cannot pass it on.

A long answer is kept whole: you see its start, its end and a note, and `tool_result_read` reads or searches the rest. Nothing is cut.

## The eight views

- `timeline` — the story, in time order, of one task (`task_id`), one project and every task under it (`project_id`), one turn of an agent (`agent` + `turn`), one conversation (`conversation`), one agent (`agent`), or the whole platform. Every record is merged into one line each: tracker events, tool calls, receipts, deliveries, turns, messages, and warning and error lines from the log. Ids are printed short with their table named, so `sql` can follow any line up. Narrow it with `since` / `until` / `around`, and with `include` to choose sources. With no window, an agent's or the platform's story is its latest turn.
  - `dojo_inspect(what="timeline", task_id="83955d30")`
  - `dojo_inspect(what="timeline", agent="<id or name>", turn=1611)`
- `conversation` — any agent's messages, oldest first, each tagged with role, party, channel, message id and turn. Needs `agent`. Narrow with `since` / `until` / `around` and `pattern`; `include_engine=false` leaves out engine notices and tool rows. It ends with the anchors to read earlier or later.
  - `dojo_inspect(what="conversation", agent="<id or name>", around="<message id>")`
- `logs` — the platform log (`dojo.log` and its rotated backup, read as one in time order). Filter with `level` (that level and above), `component`, `agent`, `pattern` and `tail`; window with `since` / `until` / `around`.
  - `dojo_inspect(what="logs", level="error", since="2026-10-19T09:00:00Z")`
- `state` — one page: version and commit, agents and their grants, providers and models, router tiers, models for platform jobs, schedules, budgets, integration switches, settings, the Ollama slots, drains, the latest Healer diagnostic. Secrets are blanked. No arguments.
- `schema` — every table with its row count and what it holds; with `table`, that table's columns, types and meanings. Credential tables are listed as not readable.
  - `dojo_inspect(what="schema", table="work_events")`
- `sql` — one read-only query (`SELECT`, `WITH` or `EXPLAIN`) on a read-only connection, rendered as a table with its row count. A write is refused, and SQLite itself refuses it again. Credential tables and columns are refused or blanked. Stop ends a long query.
  - `dojo_inspect(what="sql", query="select id, kind, title, state from work order by opened_at desc limit 20")`
- `code_search` — search the Dojo's source on GitHub at the exact commit this box runs (needs the owner's GitHub connection; without it you get the repository link and can still read a file you can name). `path` narrows to a path prefix.
  - `dojo_inspect(what="code_search", pattern="taskMovedAtSql")`
- `code_read` — read one file of the Dojo's source at the running commit, numbered, whole or by `from` / `to`.
  - `dojo_inspect(what="code_read", path="packages/server/src/inspect/timeline.ts", from=1, to=80)`

Every code result ends with the link to the source at the commit this box runs, which you can hand to the owner.

## Parameters

- **what** (string, required): which view — one of: timeline, conversation, logs, state, schema, sql, code_search, code_read
- **agent** (string, optional): an agent id or name (timeline, conversation, logs); conversation needs it. A deleted agent is still answered from the records that remain.
- **task_id** (string, optional): timeline: one task, with its events, calls and deliveries.
- **project_id** (string, optional): timeline: a project and every task under it.
- **turn** (number, optional): timeline: one turn number of `agent`.
- **conversation** (string, optional): timeline: one conversation id.
- **since** (string, optional): window start: an ISO time, a `YYYY-MM-DD HH:MM:SS` UTC time, or epoch ms (timeline, conversation, logs).
- **until** (string, optional): window end, same forms as since.
- **around** (string, optional): a message id (or its first 8 characters) or a time: the window is the turn it falls in (timeline, conversation, logs).
- **include** (array<string>, optional): timeline: only these sources — any of: events, tools, receipts, deliveries, turns, messages, logs (default all).
- **pattern** (string, optional): text to find (conversation, logs, code_search).
- **include_engine** (boolean, optional): conversation: engine notices and tool rows too (default true).
- **level** (string, optional): logs: this level and above — one of: debug, info, warn, error
- **component** (string, optional): logs: one component name.
- **tail** (number, optional): logs: only the last N matching lines.
- **table** (string, optional): schema: one table's columns and meanings (omit for every table).
- **query** (string, optional): sql: one SELECT, WITH or EXPLAIN statement.
- **path** (string, optional): code_read: a file path in the repository (e.g. packages/server/src/index.ts); code_search: a path prefix.
- **from** (number, optional): code_read: first line (from 1).
- **to** (number, optional): code_read: last line.
