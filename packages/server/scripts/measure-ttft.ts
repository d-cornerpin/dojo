/**
 * Phase 0 TTFT measurement. Times callModel() from invocation to the first
 * onChunk() callback. Pure LLM round-trip, no STT or TTS in the path.
 *
 * Run from the server package root:
 *   npm run -w packages/server exec -- tsx scripts/measure-ttft.ts
 * Or from the repo root:
 *   tsx packages/server/scripts/measure-ttft.ts
 */

import { callModel } from '../src/agent/model.js';
import { getDb } from '../src/db/connection.js';
import { loadSecrets } from '../src/config/loader.js';

const PRIMARY_AGENT_ID = 'primary'; // Just used to satisfy callModel's agentId
                                  // accounting; nothing is persisted by this
                                  // script.

async function readPrimaryModelId(): Promise<string> {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT value FROM config WHERE key = 'primary_agent_model' UNION ALL " +
      "SELECT model_id AS value FROM agents WHERE id = (SELECT value FROM config WHERE key = 'primary_agent_id')",
    )
    .all() as Array<{ value: string }>;
  for (const r of row) {
    if (r.value && r.value.length > 0) return r.value;
  }
  throw new Error('No primary agent model id found in config.');
}

async function runOnce(modelId: string, label: string): Promise<{ ttftMs: number; firstChunkLen: number; totalMs: number; totalChars: number }> {
  // Use a slightly longer prompt so the response actually streams (one-word
  // replies often arrive in a single batch from DeepSeek and we'd see a
  // round-trip time, not TTFT).
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: 'Count out loud from 1 to 10. Just the numbers, separated by commas.' },
  ];
  const start = Date.now();
  let firstChunkAt: number | null = null;
  let firstChunkLen = 0;
  let totalChars = 0;
  const result = await callModel({
    agentId: PRIMARY_AGENT_ID,
    modelId,
    messages,
    systemPrompt: 'You are a measurement target. Answer concisely.',
    tools: false,
    onChunk: (chunk: string) => {
      if (firstChunkAt === null && chunk && chunk.length > 0) {
        firstChunkAt = Date.now();
        firstChunkLen = chunk.length;
      }
      if (chunk) totalChars += chunk.length;
    },
  });
  const totalMs = Date.now() - start;
  const ttftMs = firstChunkAt !== null ? firstChunkAt - start : totalMs;
  void result;
  return { ttftMs, firstChunkLen, totalMs, totalChars };
}

async function main(): Promise<void> {
  // Load secrets (~/.dojo/secrets.yaml) so the model provider has its API key.
  loadSecrets();
  const modelId = await readPrimaryModelId();
  console.log(`[ttft] primary_agent_model id=${modelId}`);
  // First run warms the HTTPS/2 connection to the provider; the remaining
  // runs are the real measurement. Keep N small but big enough to show the
  // distribution.
  const runs: Array<Awaited<ReturnType<typeof runOnce>>> = [];
  const N = 6;
  for (let i = 0; i < N; i++) {
    const r = await runOnce(modelId, `run${i + 1}`);
    runs.push(r);
    console.log(`[ttft] run ${i + 1}: ttft=${r.ttftMs}ms (first chunk ${r.firstChunkLen} chars), total=${r.totalMs}ms (${r.totalChars} chars)`);
  }
  const warm = runs.slice(1);
  const sorted = [...warm].map((r) => r.ttftMs).sort((a, b) => a - b);
  const median = sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)]
    : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = Math.round(warm.reduce((s, r) => s + r.ttftMs, 0) / warm.length);
  console.log('\n[ttft] === SUMMARY ===');
  console.log(`[ttft] cold run 1:           ${runs[0].ttftMs}ms`);
  console.log(`[ttft] warm runs (${warm.length}): median=${median}ms  avg=${avg}ms  min=${min}ms  max=${max}ms`);
  console.log(`[ttft] reported number:       ${median}ms (median of warm)`);
}

main().then(
  () => process.exit(0),
  (err) => { console.error('[ttft] failed:', err); process.exit(1); },
);
