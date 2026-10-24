// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect C1 — WHAT THE MOST-QUERIED TABLES HOLD, written by hand.
//
// The schema view takes a table's meaning from its migration when the migration says what the
// table holds in a whole sentence (`schema-notes.ts`). For most of the tables an agent reaches
// for, none does: `work`, `messages`, `turns`, `agents`, `audit_log` and `deliveries` all read
// "(no description)" from the real chain, and `work_events`' label says what it replaced. These
// are the tables the dev box's main agent and Healer queried most through the shell (measured
// from its audit log: agents 151, work 150, messages 95, agent_tool_failures 47, work_events 47,
// audit_log 23, deliveries 13, adjudications 12, a2a_threads 5, config 3), plus `turns` and
// `tool_receipts`, which every timeline cites. Each sentence was checked against the table's
// migration and its writers; a hand-written note wins over a parsed one.
// ════════════════════════════════════════════════════════════════════════════════════════

export const TABLE_NOTES: Readonly<Record<string, string>> = {
  agents: 'Every agent the platform has created, one row each: its name, model, status, classification, group and grants; a terminated agent keeps its row.',
  work: 'The tracker: every request, task, project, commitment and run of a recurring job is one row (kind), with its state, owner, schedule and result.',
  work_events: 'The history of each tracker row (work_id): one row per change, with its kind, who made it (actor) and its details (payload, JSON).',
  messages: 'Every message of every agent\'s conversation, in order (seq): its role, content, channel and turn, and who it came from.',
  turns: 'One row per agent turn: what it served, when it started and ended, why it ended (exit_reason), and how many of its calls changed something.',
  audit_log: 'One row per model call, tool call, file access and command an agent made, with its target and result, refusals included.',
  deliveries: 'Every reply or message an agent pushed onto a channel: who it went to, on which channel, for which turn, and how it went (outcome).',
  tool_receipts: 'The engine\'s proof that a send happened (mail, text, call, agent message, calendar booking): the provider\'s id or a read-only re-check (verified, tier, basis).',
  agent_tool_failures: 'Tool calls that keep failing across turns, counted per agent and call signature (hit_count, first and last time); a success clears the row.',
  adjudications: 'Verdicts on a tracker row\'s close-out claim (upheld or rejected): who gave each, and the evidence it looked at.',
  a2a_threads: 'The threads of messages between agents: each thread\'s hop count, and its last intent and sender.',
  config: 'The platform\'s settings, one key and value per row; a credential-shaped value is blanked.',
};
