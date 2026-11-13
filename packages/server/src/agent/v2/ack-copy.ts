// Engine ack copy. The engine no longer composes user-facing acks; the agent's own words are
// delivered by the model, steered by the engine floors (steps/assemble/steer-checkpoint.ts): the
// engine never speaks as the agent. The pools below have no sender but a live reader,
// `inbound-courtesy.ts`, which exact-matches their strings coming back IN; they must NEVER change.

export const START_ACK_POOL: readonly string[] = [
  "On it. I'll let you know when it's done.",
  "Working on it now, I'll report back shortly.",
  "Got it, starting on this now.",
  "Picking this up now.",
  "On it, give me a few minutes.",
  "Sure thing, getting started on this.",
  "Alright, I'm on it. I'll circle back when it's ready.",
  "On it now, I'll follow up once it's done.",
  "Cool, diving into this now.",
  "Starting on this, back with you soon.",
];

// Mid-work flavor: the note reads "already in progress", not "starting".
export const PROGRESS_ACK_POOL: readonly string[] = [
  "Quick note, I've got this in progress and I'll let you know when it's done.",
  "Just so you know, I'm working through this now.",
  "Still on this, I'll follow up once it's wrapped up.",
  "Heads up, this is underway. More soon.",
  "Making progress on this, I'll report back when it's done.",
];

export const A2A_HANDOFF_ACK_POOL: readonly string[] = [
  "I've pulled in another agent on part of this and I'll report back as soon as they answer.",
  "Part of this is now with another agent; I'll follow up the moment I hear back.",
  "I've handed a piece of this off and will let you know as soon as the answer comes back.",
];

export const COMPLETION_ACK_POOL: readonly string[] = [
  "Done, that's all wrapped up.",
  "All set, that's finished.",
  "Done, that's taken care of.",
  "Finished, that's done.",
  "Okay, that's complete.",
];
