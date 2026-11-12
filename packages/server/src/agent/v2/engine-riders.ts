// Riders are events-lane rows that ride a turn and must never drive one; the SQL fragment below feeds
// the exclusion. A new rider must join this list, and engine-rider-never-drives-a-turn enforces it.
// hint and system have no live writer and STAY: removing a value from a live exclusion admits them.

export const ENGINE_RIDER_INTENTS = [
  'thrash_gate', 'thrash_drift', 'thrash_block', 'delegation_hint', 'owed_interrupt',
  'promise_floor', 'a2a_handoff_floor', 'auto_scaffold', 'fanout_join',
  'reminder_silence_floor',
  'project_needs_attention',
  'agent_notice', 'agent_health', 'block_validated', 'engine_event_expired',
  'image_delivery_outcome', 'file_delivery_outcome', 'dojo_message_sent', 'learning_loop', 'pm_review_failed', 'schedule_run_failed',
  'schedule_run_failed_owner', 'scheduler_missed_runs', 'spawn_timeout_decision',
  'spawn_timeout_undecided', 'validation_check',
  'reminder_skipped_owner',
  'version_gap_reconcile',
  'hint', 'system',
] as const;


export interface QueuePairedRider {
  readonly intent: string;
  readonly latch: string;
}

// Empty on purpose: the declaration an extra steer that also writes the events lane must fail against;
// the-second-channel-is-governed fails the build both ways.
export const QUEUE_PAIRED_RIDERS: Readonly<Record<string, QueuePairedRider>> = Object.freeze({
});

// The exclusion as SQL so predicate and writers cannot drift; literal from the frozen list, no interpolation.
export const ENGINE_RIDER_INTENTS_SQL =
  `(${ENGINE_RIDER_INTENTS.map((i) => `'${i}'`).join(', ')})`;
