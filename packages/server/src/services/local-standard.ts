// ════════════════════════════════════════════════════════════════════════════
// v3.5 — THE DOJO'S TWO STANDARD LOCAL MODELS. This module is the only place their tags appear.
//
// OWNER DIRECTION (2026-10-19): "From now on all boxes will have one decision model and one writing
// model that can both run and fit on a 16GB Mac mini. The system will no longer need to run on a
// larger model. If someone wants to run a larger local model, that is for agents and not for the
// dojo itself." Installed automatically.
//
//   · the DECISION model answers yes/no, which-one and how-much questions through Ollama's
//     `/v1/systemone` (`agent/decide.ts` is its only caller);
//   · the WRITER writes titles, project names, voice openers and memory summaries: it is the
//     `system` router tier and, at setup, the summary writer (`compaction_model_id`).
//
// The role agents (PM, Healer, Dreamer, Trainer, Imaginer) keep their own model keys; nothing here
// reads or writes them.
// ════════════════════════════════════════════════════════════════════════════

import os from 'node:os';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isLocalOllamaBaseUrl, computeAndStoreRecommendedNumCtx } from './num-ctx-calculator.js';
import { pullOllamaModel } from './ollama-pull.js';
import { localWorkBegins } from './ollama-quiet.js';
import { getOllamaModelInfo } from './ollama.js';
import { STANDARD_MODELS_MISSING_WORDS, tellOwnerOnce, ownerConditionCleared } from '../healer/owner-notices.js';
import { ownerCardFrame } from './owner-card-frames.js';

export { STANDARD_MODELS_MISSING_WORDS };
const MISSING_CONDITION = 'standard-models';

const logger = createLogger('local-standard');

// Sizes are the registry's published download sizes for these tags (fetched 2026-10-19).
// `windowTag` (t268): the decision model at the window the Dojo reserves for it (`services/decision-window.ts`).
export const STANDARD_DECISION_MODEL = { tag: 'tev1:4b-q4_K_M', windowTag: 'tev1-dojo:4b-q4_K_M', bytes: 2_800_000_000 } as const;
export const STANDARD_WRITER_MODEL = { tag: 'qwen3.5:4b', bytes: 3_400_000_000 } as const;
export const STANDARD_PAIR_BYTES = STANDARD_DECISION_MODEL.bytes + STANDARD_WRITER_MODEL.bytes;
/** The tags Ollama keeps resident for the Dojo itself (`services/ollama-lock.ts` pins them). */
export const STANDARD_TAGS: readonly string[] = [STANDARD_DECISION_MODEL.tag, STANDARD_WRITER_MODEL.tag];

const GIB = 1024 ** 3;
/** The owner's stated floor for a Dojo box ("a 16GB Mac mini (minimum for Dojo install)"). A box
 *  below it is not refused (no hard limits); it is told plainly what that costs. */
export const STANDARD_FLOOR_BYTES = 16 * GIB;

type Presence = 'installed' | 'missing' | 'pulling';
export interface StandardState {
  decision: Presence;
  writer: Presence;
  ollama: 'running' | 'stopped' | 'absent';
  residentBytes: number;
  note: string;
}

type Which = 'decision' | 'writer';
const TAG: Record<Which, string> = { decision: STANDARD_DECISION_MODEL.tag, writer: STANDARD_WRITER_MODEL.tag };
const LABEL: Record<Which, string> = { decision: 'the decision model', writer: 'the writer' };
/** The decision model is not a chat model: its capability keeps it out of the summary writers. */
const CAPABILITIES: Record<Which, string[]> = { decision: ['decision'], writer: ['chat'] };

const pulling = new Set<Which>();
let progressLines: string[] = [];
let inFlight: Promise<StandardState> | null = null;

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

/** The local Ollama provider row, created the way setup's auto-configure always created it. */
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

/** Is `modelId` one of the Dojo's own two models? */
export function isStandardModelRow(modelId: string | null | undefined): boolean {
  return !!modelId && (modelId === standardModelRowId('writer') || modelId === standardModelRowId('decision'));
}

async function ollamaJson<T>(baseUrl: string, path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5000) });
    return resp.ok ? (await resp.json()) as T : null;
  } catch {
    return null;
  }
}

/** Ollama's names carry `:latest` when no tag was given; the pair's tags are always explicit. */
const installedTagsOf = (tags: { models?: Array<{ name: string }> }): Set<string> =>
  new Set((tags.models ?? []).map((m) => m.name));

const gb = (bytes: number): string => (bytes / 1e9).toFixed(1);

const totalRamBytes = (): number => os.totalmem();

function noteFor(s: Omit<StandardState, 'note'>): string {
  if (s.ollama !== 'running') {
    return s.ollama === 'absent'
      ? "Ollama is not set up on this box yet, so the Dojo's two models cannot be installed."
      : "Ollama is not running, so the Dojo's two models cannot be checked or installed.";
  }
  if (s.decision === 'pulling' || s.writer === 'pulling') return "Installing the Dojo's two models.";
  const missing = (['decision', 'writer'] as const).filter((w) => s[w] === 'missing');
  if (missing.length > 0) {
    return `Not installed yet: ${missing.map((w) => `${LABEL[w]} (${TAG[w]})`).join(' and ')}. Use Repair to install it.`;
  }
  const total = totalRamBytes();
  if (total < STANDARD_FLOOR_BYTES) {
    return `This box has ${Math.round(total / GIB)} GB; the Dojo's two models need about ${Math.round(STANDARD_PAIR_BYTES / 1e9)} GB `
      + 'of memory beside the desktop and the engine, so a local agent model will not fit alongside them.';
  }
  return `Both standard models are installed (${gb(STANDARD_PAIR_BYTES)} GB).`;
}

/** What this box has of the pair right now. Never throws. */
export async function standardState(): Promise<StandardState> {
  const provider = localOllamaProvider();
  const baseUrl = provider?.baseUrl ?? 'http://localhost:11434';
  const tags = await ollamaJson<{ models?: Array<{ name: string }> }>(baseUrl, '/api/tags');
  const presence = (which: Which, installed: Set<string>): Presence =>
    pulling.has(which) ? 'pulling' : installed.has(TAG[which]) ? 'installed' : 'missing';
  if (!tags) {
    const base = { decision: presence('decision', new Set()), writer: presence('writer', new Set()), ollama: provider ? 'stopped' as const : 'absent' as const, residentBytes: 0 };
    return { ...base, note: noteFor(base) };
  }
  const installed = installedTagsOf(tags);
  const ps = await ollamaJson<{ models?: Array<{ name: string; size?: number }> }>(baseUrl, '/api/ps');
  const residentBytes = (ps?.models ?? [])
    .filter((m) => STANDARD_TAGS.includes(m.name) || m.name === STANDARD_DECISION_MODEL.windowTag)
    .reduce((sum, m) => sum + (typeof m.size === 'number' ? m.size : 0), 0);
  const base = { decision: presence('decision', installed), writer: presence('writer', installed), ollama: 'running' as const, residentBytes };
  return { ...base, note: noteFor(base) };
}

/** The progress lines of the install running now (or the last one), for the setup screen and the tile. */
export function standardProgressLines(): readonly string[] {
  return progressLines;
}

function registerModelRow(providerId: string, which: Which, info: { contextWindow: number | null; maxOutputTokens: number | null } | null): string {
  const db = getDb();
  const tag = TAG[which];
  const existing = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(providerId, tag) as { id: string } | undefined;
  if (existing) {
    // A row discovery made first carries no `decision` capability; the pair is hard-wired (owner ruling), so
    // its capability is repaired and it is re-enabled even if a person disabled it.
    db.prepare("UPDATE models SET is_enabled = 1, capabilities = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(CAPABILITIES[which]), existing.id);
    return existing.id;
  }
  const id = `ollama-${tag.replace(/[^a-z0-9]/gi, '-')}`;
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, datetime('now'), datetime('now'))
  `).run(id, providerId, tag, tag, JSON.stringify(CAPABILITIES[which]), info?.contextWindow ?? null, info?.maxOutputTokens ?? null);   // M41: what Ollama did not report is stored as not set
  return id;
}

/** The assignments the pair carries. The writer owns the `system` tier outright. The summary writer is never
 *  set here (owner ruling 2026-10-24, "The agents model."): each agent's own model writes its summaries. */
function assign(writerId: string | null, decisionId: string | null): void {
  const db = getDb();
  const upsert = db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);
  db.transaction(() => {
    if (writerId) {
      db.prepare('DELETE FROM router_tier_models WHERE tier_id = ?').run('system');
      db.prepare('INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES (?, ?, 0)').run('system', writerId);
    }
    if (decisionId) upsert.run('decision_model_id', decisionId);
  })();
}

async function install(onProgress?: (line: string) => void): Promise<StandardState> {
  const lines: Partial<Record<Which, string>> = {};
  progressLines = [];
  const say = (which: Which, line: string): void => {
    lines[which] = line;
    progressLines = (['decision', 'writer'] as const).flatMap((w) => (lines[w] ? [lines[w] as string] : []));
    onProgress?.(line);
  };
  // Ollama must answer before anything is written: a box without it gets no provider row from here.
  const tags = await ollamaJson<{ models?: Array<{ name: string }> }>(localOllamaProvider()?.baseUrl ?? 'http://localhost:11434', '/api/tags');
  if (!tags) {   // a box set up for Ollama whose Ollama does not answer: the pair cannot arrive, so he is told
    if (localOllamaProvider() && tellOwnerOnce(MISSING_CONDITION)) ownerCardFrame(STANDARD_MODELS_MISSING_WORDS, 'warning');
    return standardState();
  }
  const provider = ensureLocalOllamaProvider();
  if (!provider) return standardState();
  const installed = installedTagsOf(tags);
  const ids: Record<Which, string | null> = { decision: null, writer: null };

  for (const which of ['decision', 'writer'] as const) {
    const tag = TAG[which];
    if (!installed.has(tag)) {
      pulling.add(which);
      try {
        const outcome = await pullOllamaModel(tag, {
          baseUrl: provider.baseUrl,
          onProgress: (p) => say(which, `Downloading ${LABEL[which]} (${tag}): ${p.total > 0 ? Math.floor((p.completed / p.total) * 100) : 0}%`),
        });
        if (!outcome.ok) {
          say(which, `Downloading ${LABEL[which]} (${tag}): failed, ${outcome.error}`);
          logger.warn('Standard model pull failed', { tag, error: outcome.error });
          continue;
        }
      } catch (err) {
        say(which, `Downloading ${LABEL[which]} (${tag}): failed, ${err instanceof Error ? err.message : String(err)}`);
        continue;
      } finally {
        pulling.delete(which);
      }
    }
    say(which, `Downloading ${LABEL[which]} (${tag}): installed`);
    ids[which] = registerModelRow(provider.id, which, await getOllamaModelInfo(tag, provider.baseUrl));
    await computeAndStoreRecommendedNumCtx(ids[which] as string).catch(() => null);   // sized now, not at the next boot's backfill
  }
  assign(ids.writer, ids.decision);
  if (ids.decision) await (await import('./decision-window.js')).ensureDecisionWindowTag(provider.baseUrl);   // t268: its real window
  // Fix round 1 (I-2): an attempt that left a model missing is told once (the owner-card system); it ends when both are in.
  if (ids.writer && ids.decision) ownerConditionCleared(MISSING_CONDITION);
  else if (tellOwnerOnce(MISSING_CONDITION)) ownerCardFrame(STANDARD_MODELS_MISSING_WORDS, 'warning');
  return standardState();
}

/** Fix round 1 (I-2): the Ollama health check passes what Ollama listed; the local Ollama answering with a
 *  model of the pair missing runs the install again (no timer: answering IS the signal; single-flight). */
export function retryStandardModelsIfMissing(installedNames: readonly string[], baseUrl: string): void {
  const provider = localOllamaProvider();
  if (!provider || inFlight || provider.baseUrl !== baseUrl.replace(/\/+$/, '')) return;
  if (STANDARD_TAGS.every((t) => installedNames.includes(t)) && standardModelRowId('writer') && standardModelRowId('decision')) {
    ownerConditionCleared(MISSING_CONDITION); return;   // N4: in and registered: the card ends (unregistered: the install registers, no pull)
  }
  startStandardInstall();
}

/**
 * Pull what is missing (through the bounded pull of t114), register both as models on the local
 * Ollama provider row, assign the writer to the `system` tier and (when unset) to
 * `compaction_model_id`, set `decision_model_id`. Idempotent; concurrent callers share one run.
 */
export function ensureStandardModels(onProgress?: (line: string) => void): Promise<StandardState> {
  // Fix round 4: the whole install is in-flight work on the local Ollama: the model-limit restart never lands inside it.
  if (!inFlight) inFlight = localWorkBegins().then(async (end) => { try { return await install(onProgress); } finally { end(); } }).finally(() => { inFlight = null; });
  return inFlight;
}

/** Resolves when the install running now (if any) has finished. Starts nothing. */
export async function standardInstallSettled(): Promise<void> {
  await inFlight?.catch(() => undefined);
}

/** Start the install in the background (setup, the Repair button); progress is read back by polling. */
export function startStandardInstall(): void {
  void ensureStandardModels().catch((err) => {
    logger.warn('Standard model install failed', { error: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * The update hook (the once-per-version pattern of `prompt/shipped-souls.ts`): the first boot of a version
 * installs or repairs the pair (Ollama's model limit is re-applied at every start, below). Stamped only when
 * both are installed, so an unfinished install is tried again at the next boot. A box that never set up a
 * local Ollama is left to setup. Returns whether a run happened.
 */
export async function ensureStandardModelsOncePerVersion(version: string): Promise<boolean> {
  if (!/^\d/.test(version)) return false;
  const db = getDb();
  const seen = (db.prepare("SELECT value FROM config WHERE key = 'standard_models_version'").get() as { value: string } | undefined)?.value;
  if (seen === version || !localOllamaProvider()) return false;
  const s = await ensureStandardModels();
  if (s.decision === 'installed' && s.writer === 'installed') {
    db.prepare(`INSERT INTO config (key, value, updated_at) VALUES ('standard_models_version', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(version);
  } else {
    logger.warn('The Dojo\'s two standard models are not both installed after the update; the next boot tries again', { note: s.note });
  }
  return true;
}

/** The boot hook: background, never fatal. */
export async function ensureStandardModelsAtBoot(): Promise<void> {
  await (await import('./ollama-model-limit.js')).ensureOllamaModelLimit();   // every start: launchctl's variable dies with a reboot
  try {
    const { getCurrentVersion } = await import('../gateway/routes/update.js');
    await ensureStandardModelsOncePerVersion(getCurrentVersion());
  } catch (err) {
    logger.warn('Standard model check at boot failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }
}
