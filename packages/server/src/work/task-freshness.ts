// ════════════════════════════════════════════════════════════════════════════════════════
// WHEN A TASK LAST MOVED — ONE EXPRESSION, READ BY THE PM'S LADDER AND THE CLOSE-OUT GATE
// (t143 round 2, orchestrator ruling: a task's freshness may only be refreshed by activity that
// structurally names THAT task).
//
// `work.updated_at` is written only by changes to that row (a status, a claim, an edit, a
// schedule; and, since round 2, the engine checkpoint for the job's OWN tasks — see
// `engine-checkpoint-note.ts`). What it never saw is a "still working" note: `work_note` appends
// an event and touches no column. So the task's movement is the newer of its row's clock and its
// own events: its transitions, its opening and claim, the turn-finalize `activity` stamp (written
// only for turns whose trigger names the task, round 2), and anything its assignee wrote on it.
// A PM poke, the PM's own notes and engine bookkeeping are not the task moving.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Epoch ms the task aliased `a` last moved. */
export const taskMovedAtSql = (a: string): string => `MAX(${a}.updated_at, COALESCE((SELECT MAX(e.created_at)
  FROM work_events e WHERE e.work_id = ${a}.id AND (e.kind IN ('transition', 'activity', 'opened', 'claim_turn')
  OR e.actor IN (${a}.agent_id, 'agent:' || ${a}.agent_id))), 0))`;
