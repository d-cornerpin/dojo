// Ollama version checks: no other file compares versions (minimums sit beside the model tag in `local-standard.ts`).

import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';

/** `0.40.13`, `v0.35.0`, `0.36.0-rc2` → [0, 40, 13]; anything else → null. */
export function parseOllamaVersion(v: string | null | undefined): number[] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec((v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** A pre-release (`0.36.0-rc2`) ranks BELOW the release it leads up to. */
const isPrerelease = (v: string | null): boolean => /^v?\d+\.\d+(?:\.\d+)?-/.test((v ?? '').trim());
/** A source build reports 0.0.0: neither old nor new. */
export const isUnknownBuild = (v: string | null): boolean => (parseOllamaVersion(v) ?? [1]).every((n) => n === 0);

export function ollamaAtLeast(have: string | null, need: string): boolean {
  const h = parseOllamaVersion(have);
  const n = parseOllamaVersion(need);
  if (!h || !n) return false;
  for (let i = 0; i < 3; i++) if (h[i] !== n[i]) return h[i] > n[i];
  return !isPrerelease(have) || isPrerelease(need);
}

export function requiredOllamaVersion(models: ReadonlyArray<{ minOllama: string | null }>): string | null {
  let need: string | null = null;
  for (const m of models) if (m.minOllama && (need === null || !ollamaAtLeast(need, m.minOllama))) need = m.minOllama;
  return need;
}

export async function readOllamaVersion(baseUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const body = await resp.json() as { version?: unknown };
    return typeof body.version === 'string' && parseOllamaVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

export const isVersionRefusal = (error: string): boolean => /newer version of ollama/i.test(error);

export const plainPullError = (error: string, why?: string | null): string =>
  (isVersionRefusal(error) ? `This model needs a newer Ollama than this Mac runs. ${why ?? 'The Dojo could not update it by itself.'}` : error);

/** The upkeep's one record (`ollama-upkeep.ts`), a JSON config row of what it could not finish. */
export interface UpkeepRecord {
  held?: string; starting?: 'app' | 'service' | 'serve'; limitOwed?: boolean; settled?: { pid: number; path: string; limit?: number }; triedAt?: number;
}
const RECORD = 'ollama_upkeep';
export function upkeepRecord(): UpkeepRecord {
  try { return JSON.parse((getDb().prepare('SELECT value FROM config WHERE key = ?').get(RECORD) as { value: string } | undefined)?.value ?? '{}') as UpkeepRecord; } catch { return {}; }
}
/** Merge `change` into the record; a field set to undefined is removed. */
export function noteUpkeep(change: Partial<Record<keyof UpkeepRecord, unknown>>): void {
  setConfigValue(RECORD, JSON.stringify({ ...upkeepRecord(), ...change }));
}
export const heldOllamaVersion = (): string | null => upkeepRecord().held ?? null;
