// KV-cache bytes per token from an Ollama model's `/api/show` fields, shared by `agent/local-model-fit.ts` and
// `num-ctx-calculator.ts`. fp16 K and V, deliberately high: a slight overestimate beats an OOM.

const KV_BYTES_PER_ELEMENT = 2;

export function kvBytesPerTokenOf(mi: Record<string, unknown>, archField: string): number | { reason: string } {
  const blockCount = mi[`${archField}.block_count`];
  const headCount = mi[`${archField}.attention.head_count`];
  const headCountKvRaw = mi[`${archField}.attention.head_count_kv`];
  const embeddingLength = mi[`${archField}.embedding_length`];
  if (typeof blockCount !== 'number' || typeof headCount !== 'number' || typeof embeddingLength !== 'number') {
    return { reason: `missing required arch fields (block_count, head_count, embedding_length) for ${archField}` };
  }
  if (headCount === 0) return { reason: 'head_count is zero' };
  // Missing head_count_kv: assume full attention (the safe direction, a smaller window).
  const headCountKv = typeof headCountKvRaw === 'number' && headCountKvRaw > 0 ? headCountKvRaw : headCount;
  const kvBytesPerToken = 2 /* K + V */ * blockCount * headCountKv * (embeddingLength / headCount) * KV_BYTES_PER_ELEMENT;
  if (!Number.isFinite(kvBytesPerToken) || kvBytesPerToken <= 0) {
    return { reason: 'computed kv_bytes_per_token is non-positive or NaN' };
  }
  return kvBytesPerToken;
}
