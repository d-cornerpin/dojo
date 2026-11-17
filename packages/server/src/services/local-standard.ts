// The Dojo's two standard local models: the DECISION model (yes/no and which-one questions via `/v1/systemone`,
// `agent/decide.ts`) and the WRITER (titles, names). Tags live only here.
// `ollama-upkeep.ts` installs them.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isLocalOllamaBaseUrl } from './num-ctx-calculator.js';

const logger = createLogger('local-standard');

// `windowTag`: the decision model at the window the Dojo reserves (`services/decision-window.ts`). `minOllama`: the
// oldest Ollama it runs on, declared only here; the upkeep updates an older Ollama first.
export const STANDARD_DECISION_MODEL = { tag: 'tev1:4b-q4_K_M', windowTag: 'tev1-dojo:4b-q4_K_M', bytes: 2_800_000_000, minOllama: '0.35' } as const;
export const STANDARD_WRITER_MODEL = { tag: 'qwen3.5:4b', bytes: 3_400_000_000, minOllama: null } as const;
export const STANDARD_PAIR_BYTES = STANDARD_DECISION_MODEL.bytes + STANDARD_WRITER_MODEL.bytes;
/** The tags Ollama keeps resident for the Dojo itself (`services/ollama-lock.ts` pins them). */
export const STANDARD_TAGS: readonly string[] = [STANDARD_DECISION_MODEL.tag, STANDARD_WRITER_MODEL.tag];
/** Ollama's names less the Dojo's own window tag: never a model to list, register, remove or download. */
export const withoutDojoInternalTags = (names: string[]): string[] => names.filter((n) => n !== STANDARD_DECISION_MODEL.windowTag);

const GIB = 1024 ** 3;
/** The floor for a Dojo box (a 16 GB Mac mini). A box below it is not refused; it is told plainly what that costs. */
export const STANDARD_FLOOR_BYTES = 16 * GIB;

type Which = 'decision' | 'writer';
const TAG: Record<Which, string> = { decision: STANDARD_DECISION_MODEL.tag, writer: STANDARD_WRITER_MODEL.tag };

/** The local Ollama provider row (a localhost base URL), or null when this box has none. */
export function localOllamaProvider(): { id: string; baseUrl: string } | null {
  try {
    const rows = getDb().prepare("SELECT id, base_url FROM providers WHERE type = 'ollama' ORDER BY created_at, id")
      .all() as Array<{ id: string; base_url: string | null }>;
    const local = rows.find((r) => isLocalOllamaBaseUrl(r.base_url));
    return local ? { id: local.id, baseUrl: (local.base_url ?? 'http://localhost:11434').replace(/\/+$/, '') } : null;
  } catch {
    return null;
  }
}

export function ensureLocalOllamaProvider(): { id: string; baseUrl: string } | null {
  const existing = localOllamaProvider();
  if (existing) return existing;
  getDb().prepare(`
    INSERT OR IGNORE INTO providers (id, name, type, base_url, auth_type, is_validated, validated_at, created_at, updated_at)
    VALUES ('ollama-local', 'Ollama (Local)', 'ollama', 'http://localhost:11434', 'none', 1, datetime('now'), datetime('now'), datetime('now'))
  `).run();
  logger.info('Auto-configured Ollama provider');
  return localOllamaProvider();
}

/** The `models` row id registered for one of the pair on the local provider, enabled; else null. */
export function standardModelRowId(which: Which): string | null {
  const provider = localOllamaProvider();
  if (!provider) return null;
  try {
    const row = getDb().prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ? AND is_enabled = 1')
      .get(provider.id, TAG[which]) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** Bytes of the pair this box has not installed yet, which the next upkeep downloads; none without a local Ollama. */
export function missingStandardBytes(): number {
  if (!localOllamaProvider()) return 0;
  return (standardModelRowId('decision') ? 0 : STANDARD_DECISION_MODEL.bytes) + (standardModelRowId('writer') ? 0 : STANDARD_WRITER_MODEL.bytes);
}

export const STANDARD_ROW_STAYS = 'The Dojo itself runs on this model for memory summaries and quick checks, so it stays on.';

/** The Ollama tag's own row is one of the pair: the one question the Models tab and the Setup screen both ask. */
export function isStandardTag(tag: string): boolean {
  const provider = localOllamaProvider();
  const row = provider ? getDb().prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(provider.id, tag) as { id: string } | undefined : undefined;
  return isStandardModelRow(row?.id);
}

export function isStandardModelRow(modelId: string | null | undefined): boolean {
  return !!modelId && (modelId === standardModelRowId('writer') || modelId === standardModelRowId('decision'));
}

export async function ollamaJson<T>(baseUrl: string, path: string, signal: AbortSignal = AbortSignal.timeout(5000)): Promise<T | null> {
  try {
    const resp = await fetch(`${baseUrl}${path}`, { signal });
    return resp.ok ? (await resp.json()) as T : null;
  } catch {
    return null;
  }
}
