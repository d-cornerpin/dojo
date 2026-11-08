// ════════════════════════════════════════════════════════════════════════════
// ONE BOUNDED OLLAMA PULL (t114, census U8), shared by the setup route and the standard-models
// install (`services/local-standard.ts`, v3.5). Moved out of `gateway/routes/setup-deps.ts`
// unchanged so the Dojo's own install and a person's manual pull are the same pull.
//
// THE DEFECT t114 fixed: a flat 30 minutes covering the whole streamed pull. A 70 GB model on a
// home line takes longer than that, so the download was aborted mid-transfer while the progress
// lines were actively tracking real bytes arriving. Ollama streams a JSON progress line per chunk,
// so arrival is the measured fact of liveness: the bound re-arms on each line, a registry that goes
// quiet is still cut, and a ceiling that does not re-arm keeps a pull that dribbles for ever bounded.
// ════════════════════════════════════════════════════════════════════════════

import { idleStreamDeadline } from './idle-stream-deadline.js';
import { localWorkBegins } from './ollama-lock.js';

// The pull's three bounds, each named for its own job. A registry that never answers is a different
// failure from one that stops mid-download, and neither is "this model is too big".
const OLLAMA_PULL_FIRST_BYTE_MS = 60_000;
export const OLLAMA_PULL_IDLE_MS = 2 * 60_000;
const OLLAMA_PULL_CEILING_MS = 6 * 60 * 60_000;

export interface PullProgress {
  model: string;
  status: string;
  completed: number;
  total: number;
  layers: number;
  error: string | null;
}

export type PullOutcome =
  | { ok: true; status: string }
  | { ok: false; error: string; httpError?: boolean; stalled?: boolean };

/**
 * Pull `model` from the Ollama at `baseUrl`, reporting cumulative progress across every layer.
 * Never throws for an Ollama-side failure; a network failure that is not the idle bound rethrows so
 * the caller's own error path (the route's `routeFailure`) keeps its shape.
 */
export async function pullOllamaModel(
  model: string,
  opts: { baseUrl?: string; onProgress?: (p: PullProgress) => void } = {},
): Promise<PullOutcome> {
  const baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  const report = opts.onProgress ?? (() => { /* nobody is watching */ });
  report({ model, status: 'starting', completed: 0, total: 0, layers: 0, error: null });

  const endLocalWork = localWorkBegins(baseUrl);   // an Ollama restart never cuts a pull
  const pullDeadline = idleStreamDeadline({
    firstByteMs: OLLAMA_PULL_FIRST_BYTE_MS,
    idleMs: OLLAMA_PULL_IDLE_MS,
    ceilingMs: OLLAMA_PULL_CEILING_MS,
  });

  try {
    const resp = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: pullDeadline.signal,
    });

    if (!resp.ok) return { ok: false, error: await resp.text(), httpError: true };

    const reader = resp.body?.getReader();
    if (!reader) return { ok: false, error: 'No response body', httpError: true };

    const decoder = new TextDecoder();
    let lastStatus = '';
    // Track cumulative progress across all digests/layers
    const digestProgress = new Map<string, { total: number; completed: number }>();
    // A network chunk can cut a JSON line in half: keep the unfinished tail so the next chunk
    // completes it instead of dropping a line that neither half alone can parse.
    let pending = '';

    const handleLine = (line: string): PullOutcome | null => {
      if (line === '') return null;
      let json: { status?: string; error?: string; digest?: string; total?: number; completed?: number };
      try { json = JSON.parse(line); } catch { return null; /* skip non-JSON lines */ }
      lastStatus = json.status ?? lastStatus;
      if (json.error) {
        report({ model, status: 'error', completed: 0, total: 0, layers: 0, error: json.error });
        return { ok: false, error: json.error, httpError: true };
      }
      if (json.digest && json.total) digestProgress.set(json.digest, { total: json.total, completed: json.completed ?? 0 });
      let total = 0;
      let completed = 0;
      for (const [, dp] of digestProgress) { total += dp.total; completed += dp.completed; }
      report({ model, status: json.status ?? 'downloading', completed, total, layers: digestProgress.size, error: null });
      return null;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // t114 (U8): a progress line IS the proof the pull is moving. This is the whole fix.
      pullDeadline.bump();
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const outcome = handleLine(line);
        if (outcome) return outcome;
      }
    }
    // Flush the decoder: the last line may have arrived with no trailing newline.
    pending += decoder.decode();
    if (pending !== '') {
      const outcome = handleLine(pending);
      if (outcome) return outcome;
    }
    return { ok: true, status: lastStatus };
  } catch (err) {
    // t114 (U8): say which bound ended it. "the registry went quiet" is a different problem from
    // "this model is too big to pull", and the old flat wall could not tell them apart.
    if (pullDeadline.fired()) {
      const error = `the pull stopped making progress for ${Math.round(OLLAMA_PULL_IDLE_MS / 1000)}s and was stopped`;
      report({ model, status: 'error', completed: 0, total: 0, layers: 0, error });
      return { ok: false, error, stalled: true };
    }
    throw err;
  } finally {
    pullDeadline.done();
    endLocalWork();
  }
}
