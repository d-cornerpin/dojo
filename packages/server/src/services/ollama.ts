// ════════════════════════════════════════
// Ollama Provider Integration
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { upkeepWhenIncomplete } from './ollama-upkeep.js';
import { getDb } from '../db/connection.js';
import { clearOn } from '../memory/writer.js';

const logger = createLogger('ollama');

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

interface OllamaModel {
  name: string;
  size: number;
  capabilities: string[];
}

let cachedStatus: {
  available: boolean;
  models: string[];
  lastCheck: string;
} = {
  available: false,
  models: [],
  lastCheck: '',
};

export async function checkOllamaHealth(baseUrl?: string): Promise<boolean> {
  const url = baseUrl ?? DEFAULT_OLLAMA_URL;

  try {
    const response = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    const healthy = response.ok;

    cachedStatus.available = healthy;
    cachedStatus.lastCheck = new Date().toISOString();

    if (healthy) {
      const data = await response.json() as { models?: Array<{ name: string }> };
      cachedStatus.models = (data.models ?? []).map(m => m.name);
      upkeepWhenIncomplete(cachedStatus.models, url);   // Ollama answering is the signal to finish the pair
      ollamaAnswered(url);   // t268 breaker fix: a waiting summary writer on this Ollama is re-tested
    }

    return healthy;
  } catch (err) {
    logger.debug('Ollama health check failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    cachedStatus.available = false;
    cachedStatus.lastCheck = new Date().toISOString();
    return false;
  }
}

export async function listOllamaModels(baseUrl?: string): Promise<OllamaModel[]> {
  const url = baseUrl ?? DEFAULT_OLLAMA_URL;

  try {
    const response = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.warn('Ollama list models failed', { status: response.status });
      return [];
    }

    const data = await response.json() as {
      models?: Array<{
        name: string;
        size: number;
        details?: {
          family?: string;
          parameter_size?: string;
        };
      }>;
    };

    return (data.models ?? []).map(m => {
      // Infer capabilities from model name/family
      const capabilities: string[] = ['chat'];
      const nameLower = m.name.toLowerCase();
      if (nameLower.includes('code') || nameLower.includes('deepseek')) {
        capabilities.push('code');
      }
      if (nameLower.includes('vision') || nameLower.includes('llava')) {
        capabilities.push('vision');
      }

      return {
        name: m.name,
        size: m.size,
        capabilities,
      };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Ollama is optional; not running is the normal case and the sibling health
    // check logs that at debug. Match it: a connection failure is debug, an
    // unexpected error keeps warn/error. Either way we return [].
    const notRunning = /ECONNREFUSED|fetch failed|aborted|timeout|ENOTFOUND|network/i.test(msg);
    if (notRunning) logger.debug('Ollama not reachable while listing models', { error: msg });
    else logger.error('Failed to list Ollama models', { error: msg });
    return [];
  }
}

// The installed model NAMES, in the `name:tag` form `ollama list` prints and the
// export manifest records.
//
// THIS EXISTS TO REPLACE `execSync('ollama list')`. The migration manifest and
// the post-migration checks both shelled out to the CLI to answer "which models
// does this box have?" — and on macOS the `ollama` CLI AUTO-LAUNCHES Ollama.app
// when no daemon is listening. A probe whose whole job is to ASK whether the
// backend is there was therefore capable of STARTING it, inheriting whatever
// environment the caller had: a vitest worker running under a sandboxed HOME
// started a daemon that then served an empty model store to the real box until
// it was restarted by hand (ritual round 9, run-53015 w17). An HTTP GET cannot
// launch anything, so daemon-down answers the honest [] instead.
export async function listOllamaModelNames(baseUrl?: string): Promise<string[]> {
  return (await listOllamaModels(baseUrl)).map(m => m.name);
}

// Fetch detailed model info from /api/show (context length, parameter count, etc.)
export async function getOllamaModelInfo(modelName: string, baseUrl?: string): Promise<{
  contextWindow: number | null;
  maxOutputTokens: number | null;
} | null> {  const url = baseUrl ?? DEFAULT_OLLAMA_URL;

  try {
    const response = await fetch(`${url}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      model_info?: Record<string, unknown>;
      parameters?: string;
    };

    // Extract context length from model_info or parameters.
    // M41: NULL means "the server did not say". There is no stand-in figure here: a guessed window or
    // cap written to a model row looks exactly like a real one and then overwrites the real one.
    let contextWindow: number | null = null;
    let maxOutputTokens: number | null = null;
    // FA-PC7: track whether num_predict was actually parsed so the ctx/4
    // heuristic below applies ONLY to genuinely-unset models. Without this, a
    // model whose real num_predict is 8192 was indistinguishable from the unset
    // default and got its cap silently overwritten by the heuristic.
    let maxOutputExplicit = false;

    // model_info often has context_length or num_ctx. The model's own window is the exact
    // `<arch>.context_length` key — the one num-ctx-calculator reads. A loose walk over all
    // keys is only the fallback when that key is absent, and it must skip rope-scaling figures
    // (`*.rope.scaling.original_context_length`), which sort after the real key and used to win.
    if (data.model_info) {
      const arch = data.model_info['general.architecture'];
      const ownWindow = typeof arch === 'string' ? data.model_info[`${arch}.context_length`] : undefined;
      if (typeof ownWindow === 'number' && ownWindow > 0) {
        contextWindow = ownWindow;
      } else {
        for (const [key, value] of Object.entries(data.model_info)) {
          const keyLower = key.toLowerCase();
          if (keyLower.includes('rope') || keyLower.endsWith('original_context_length')) continue;
          if ((keyLower.includes('context_length') || keyLower === 'num_ctx') && typeof value === 'number') {
            contextWindow = value;
          }
        }
      }
    }

    // parameters string may contain "num_ctx" or "num_predict"
    if (data.parameters) {
      const ctxMatch = data.parameters.match(/num_ctx\s+(\d+)/);
      if (ctxMatch) contextWindow = parseInt(ctxMatch[1], 10);

      const predictMatch = data.parameters.match(/num_predict\s+(\d+)/);
      if (predictMatch) {
        maxOutputTokens = parseInt(predictMatch[1], 10);
        maxOutputExplicit = true;
      }
    }

    // max output is typically a fraction of context window if not explicitly set, derived ONLY from a
    // window the server actually reported (M41).
    // FA-PC7: gate on the parsed flag, not on a sentinel value, so a real
    // num_predict of 8192 (with a large ctx) is respected rather than overwritten.
    if (!maxOutputExplicit && contextWindow !== null && contextWindow > 32000) {
      maxOutputTokens = Math.min(Math.floor(contextWindow / 4), 32768);
    }

    logger.info('Ollama model info fetched', { modelName, contextWindow, maxOutputTokens });
    return { contextWindow, maxOutputTokens };
  } catch (err) {
    logger.debug('Failed to fetch Ollama model info', {
      modelName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Ollama at `url` answered: its free memory may be readable again, and each Ollama provider there is a signal for a
 *  summary span waiting on a writer it serves (`memory/writer.ts`). */
function ollamaAnswered(url: string): void {
  clearOn({ kind: 'memory-readable' });
  try {
    const norm = (u: string | null): string => (u ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
    const rows = getDb().prepare("SELECT id, base_url FROM providers WHERE type = 'ollama'").all() as Array<{ id: string; base_url: string | null }>;
    for (const r of rows) if (norm(r.base_url) === norm(url)) clearOn({ kind: 'writer-answered', providerKey: r.id });
  } catch { /* no database yet: nothing waits */ }
}

export function getOllamaStatus(): { available: boolean; models: string[]; lastCheck: string } {
  return { ...cachedStatus };
}
