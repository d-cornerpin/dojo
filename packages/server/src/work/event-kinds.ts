// THE DECLARED LIST OF `work_events.kind` VALUES: the single source of truth. The live CHECK (the last
// migration carrying it, now `901_task_done_one_path.sql`) admits exactly these;
// `work/__tests__/work-event-kinds-conformance.test.ts` asserts the two are set-equal.

/** Every value `work_events.kind` may hold, sorted as the CHECK is. */
export const WORK_EVENT_KINDS = [
  'activity',
  'audit',
  'child_settled',
  'claim_rejected',
  'claim_turn',
  'claim_upheld',
  'compile_resolved',
  'continued',
  'decided',
  'floor_ghosted',
  'hand_in_refused',
  'handed_in',
  'join_complete',
  'join_opened',
  'measured',
  'occurrence_fired',
  'occurrence_released',
  'occurrence_settled',
  'opened',
  'override_request',
  'override_resolved',
  'owed_interrupt',
  // `person_told`, `poke`, `poke_remediation`: old rows only; nothing writes them.
  'person_told',
  'poke',
  'poke_remediation',
  'proof_opened',
  'rearm_refused',
  'revert_reset',
  'stalled',
  'transition',
  'user_verdict_cleared',
  'user_verdict_requested',
  'validation_escalated',
  'validation_requested',
] as const;

/** The type `appendWorkEvent`'s `kind` parameter is narrowed to: an off-list kind is refused at compile time. */
export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];
