// ════════════════════════════════════════
// Ollama Provider Integration
// ════════════════════════════════════════

import { createLogger } from '../logger.js';

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
    logger.error('Failed to list Ollama models', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// Fetch detailed model info from /api/show (context length, parameter count, etc.)
export async function getOllamaModelInfo(modelName: string, baseUrl?: string): Promise<{
  contextWindow: number;
  maxOutputTokens: number;
} | null> {
  const url = baseUrl ?? DEFAULT_OLLAMA_URL;

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

    // Extract context length from model_info or parameters
    let contextWindow = 128000; // default
    let maxOutputTokens = 8192; // default

    // model_info often has context_length or num_ctx
    if (data.model_info) {
      for (const [key, value] of Object.entries(data.model_info)) {
        const keyLower = key.toLowerCase();
        if ((keyLower.includes('context_length') || keyLower === 'num_ctx') && typeof value === 'number') {
          contextWindow = value;
        }
      }
    }

    // parameters string may contain "num_ctx" or "num_predict"
    if (data.parameters) {
      const ctxMatch = data.parameters.match(/num_ctx\s+(\d+)/);
      if (ctxMatch) contextWindow = parseInt(ctxMatch[1], 10);

      const predictMatch = data.parameters.match(/num_predict\s+(\d+)/);
      if (predictMatch) maxOutputTokens = parseInt(predictMatch[1], 10);
    }

    // max output is typically a fraction of context window if not explicitly set
    if (maxOutputTokens === 8192 && contextWindow > 32000) {
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

export function getOllamaStatus(): { available: boolean; models: string[]; lastCheck: string } {
  return { ...cachedStatus };
}
