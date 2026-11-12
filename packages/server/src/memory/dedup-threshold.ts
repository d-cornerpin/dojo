// The one cosine-similarity threshold above which two short texts count as the same thing: shared by the A2A
// transport's repeat check and the Dreamer's lesson dedup, so it lives here once.
export const SEMANTIC_DEDUP_THRESHOLD = 0.85;
