// How long until something counts as stuck: four cliffs that deliberately differ, each enforced from one site.
// Imports stay empty so the engine, the Healer and the scheduler read them without an edge to each other.

// A `working` row this old belongs to a dead process: a live turn refreshes its row every 30 seconds.
export const STUCK_AGENT_THRESHOLD_MINUTES = 75;

// The Healer surfaces a turn that has said `working` this long, well before the reaper's cliff.
export const HEALER_WORKING_STUCK_MINUTES = 10;

// An agent silent this long is dormant, not troubled (a recent status change still counts).
export const DORMANT_THRESHOLD_DAYS = 7;

// A recurring run left `in_progress` this long without activity is force-recovered by the scheduler.
export const HARD_STUCK_THRESHOLD_MINUTES = 120;
