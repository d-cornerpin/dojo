// What Ollama version the Dojo's own models need, what this box runs, and the one version the Dojo could not update.
// A model's minimum is declared next to its tag (`local-standard.ts`, `minOllama`); no other file compares versions.

import { getDb } from '../db/connection.js';

/** `0.40.13`, `v0.35.0`, `0.36.0-rc2` → [0, 40, 13]; anything else → null. */
export function parseOllamaVersion(v: string | null | undefined): number[] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec((v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** `0.36.0-rc2`: a pre-release ranks BELOW the release it leads up to. */
const isPrerelease = (v: string | null): boolean => /^v?\d+\.\d+(?:\.\d+)?-/.test((v ?? '').trim());
/** A source build reports 0.0.0: its version says nothing, so it is neither old nor new. */
export const isUnknownBuild = (v: string | null): boolean => (parseOllamaVersion(v) ?? [1]).every((n) => n === 0);

/** Is `have` at least `need`? An unreadable version is not "at least" anything. */
export function ollamaAtLeast(have: string | null, need: string): boolean {
  const h = parseOllamaVersion(have);
  const n = parseOllamaVersion(need);
  if (!h || !n) return false;
  for (let i = 0; i < 3; i++) if (h[i] !== n[i]) return h[i] > n[i];
  return !isPrerelease(have) || isPrerelease(need);
}

/** The highest minimum among `models` that declare one, or null when none does. */
export function requiredOllamaVersion(models: ReadonlyArray<{ minOllama: string | null }>): string | null {
  let need: string | null = null;
  for (const m of models) if (m.minOllama && (need === null || !ollamaAtLeast(need, m.minOllama))) need = m.minOllama;
  return need;
}

/** The running Ollama's version, or null when it does not answer or does not say. */
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

/** The registry's refusal of a model the running Ollama is too old for (the owner's field text: "412: The model you
 *  are attempting to pull requires a newer version of Ollama"). */
export const isVersionRefusal = (error: string): boolean => /newer version of ollama/i.test(error);

/** A manual pull's failure in the words the setup screen shows: the registry's version refusal becomes plain (its own
 *  text stays in the log); any other failure is the model name's or the network's and is shown as it came. */
export const plainPullError = (error: string, why?: string | null): string =>
  (isVersionRefusal(error) ? `This model needs a newer Ollama than this Mac runs. ${why ?? 'The Dojo could not update it by itself.'}` : error);

export const readConfig = (key: string): string | null =>
  (getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
export const setConfig = (key: string, value: string | null): void => {
  if (value === null) { getDb().prepare('DELETE FROM config WHERE key = ?').run(key); return; }
  getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value);
};

const HELD = 'ollama_held_version';
/** The running Ollama's version the Dojo could not update (`ollama-upkeep.ts`), or null when nothing is held. */
export function heldOllamaVersion(): string | null { try { return readConfig(HELD); } catch { return null; } }
export const holdOllamaVersion = (version: string | null): void => setConfig(HELD, version);
