// The KV-cache cost of one token for an Ollama model, from its `/api/show` architecture fields.
// Moved out of `num-ctx-calculator.ts` unchanged (v3.5) so the memory-fit gate (`agent/local-model-fit.ts`)
// sizes a window by the SAME arithmetic the window recommendation uses.
//
// fp16 K and V caches (2 tensors, 2 bytes each), conservative: real runtimes may use Q8 or mixed
// precision, which would halve the footprint, but a slightly high figure beats one that OOMs.
//   head_dim           = embedding_length / head_count
//   kv_heads           = head_count_kv || head_count
//   kv_bytes_per_token = 2 * block_count * kv_heads * head_dim * 2

const KV_BYTES_PER_ELEMENT = 2;

/** Bytes per token, or `{ reason }` when the architecture fields are missing or unusable. */
export function kvBytesPerTokenOf(mi: Record<string, unknown>, archField: string): number | { reason: string } {
  const blockCount = mi[`${archField}.block_count`];
  const headCount = mi[`${archField}.attention.head_count`];
  const headCountKvRaw = mi[`${archField}.attention.head_count_kv`];
  const embeddingLength = mi[`${archField}.embedding_length`];
  if (typeof blockCount !== 'number' || typeof headCount !== 'number' || typeof embeddingLength !== 'number') {
    return { reason: `missing required arch fields (block_count, head_count, embedding_length) for ${archField}` };
  }
  if (headCount === 0) return { reason: 'head_count is zero' };
  // Missing head_count_kv → fall back to full attention (head_count): the safe direction, a smaller
  // window rather than an impossibly large one.
  const headCountKv = typeof headCountKvRaw === 'number' && headCountKvRaw > 0 ? headCountKvRaw : headCount;
  const kvBytesPerToken = 2 /* K + V */ * blockCount * headCountKv * (embeddingLength / headCount) * KV_BYTES_PER_ELEMENT;
  if (!Number.isFinite(kvBytesPerToken) || kvBytesPerToken <= 0) {
    return { reason: 'computed kv_bytes_per_token is non-positive or NaN' };
  }
  return kvBytesPerToken;
}
