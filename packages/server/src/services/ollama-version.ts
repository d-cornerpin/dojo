// ════════════════════════════════════════════════════════════════════════════
// FIX W — WHAT OLLAMA VERSION THE DOJO'S OWN MODELS NEED, AND WHAT THIS BOX RUNS.
//
// A model's tag is declared with the minimum Ollama it needs, next to the tag, in `local-standard.ts`
// (`minOllama`). The Dojo asks the running Ollama for its version (`GET /api/version` → `{"version":"0.40.13"}`)
// before it pulls, so a too-old Ollama is upgraded first instead of being sent a pull the registry refuses
// (HTTP 412 "requires a newer version of Ollama"; field failure of 3.5.0-preflight.1). No other file compares
// Ollama versions.
// ════════════════════════════════════════════════════════════════════════════

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
