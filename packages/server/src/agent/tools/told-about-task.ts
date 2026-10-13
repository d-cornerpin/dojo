// ════════════════════════════════════════════════════════════════════════════════════════
// t146 — A SEND THAT NAMES ITS TASK.
//
// Every person-reaching send tool (exactly the set the tool-dispatch door opens a delivery
// scope for: `agent/v2/outbound.ts:outboundChannelForTool`) carries this one OPTIONAL argument.
// When the agent passes it, the dispatch door records that the person was told about that task
// (`work/validation-drive.ts:recordPersonTold`, via `send_tool`), from the delivery the send
// itself wrote — so the owner-escalation ladder does not steer the agent to raise it again, and
// does not tell the owner a second time. Omitted means no record (the ladder's fail-safe stays).
// The task is never inferred from the words of the message or from what the turn was serving.
//
// Named `task_id` because every other agent tool that names a work row does (t142 fix round 1
// census: `spawn_agent`, `work_update`, `work_note`, `work_close_request`, `work_validate`,
// `work_schedule`), and resolved the way they resolve it (a full id, or a prefix of 8+).
//
// These bytes sit in every send tool's schema, i.e. in the cached tool array: changing them
// moves the prompt prefix once for every agent holding a send tool (G2).
// ════════════════════════════════════════════════════════════════════════════════════════

export const TOLD_ABOUT_TASK_ARG = 'task_id';

export const TOLD_ABOUT_TASK_PROPERTY = {
  type: 'string',
  description: 'Optional. The id of the task this message tells the person about (for example, raising a blocked task with the owner). Pass it and the platform knows they were told, so it will not raise that task with them again. Leave it out for anything else.',
};
