// The one cosine-similarity threshold above which two short texts count as the same thing.
// The A2A transport's "a sender is repeating themselves" check and the Dreamer's lessons
// ("this cue is one we already have") use the same number, so it lives here once.
export const SEMANTIC_DEDUP_THRESHOLD = 0.85;
