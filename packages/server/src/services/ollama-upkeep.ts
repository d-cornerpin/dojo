// ════════════════════════════════════════════════════════════════════════════
// THE ONE ROUTINE THAT KEEPS THIS BOX'S OLLAMA AND THE DOJO'S TWO STANDARD MODELS RIGHT.
//
// `upkeep(reason)` reads the running version; when it is too old, Homebrew updates the program on disk BEFORE anything
// is stopped, then Ollama is restarted as a kind that lasts (the app, or Homebrew's service) with the raised loaded-model
// limit, once no local model is busy; a missing model of the pair is pulled; the two rows are registered. Setup, every
// Dojo start, Repair and a health check that finds the pair incomplete all run it, one run at a time. What it cannot fix
// is one owner notice (key `ollama`) and one held version: a health check tries again only once the version changes.
// Only an Ollama program is ever stopped; nothing here runs `--zap` or `uninstall`, strips quarantine, or touches
// `~/.ollama`. An Ollama app from ollama.com is moved to the Trash once Homebrew's own Ollama serves.
// ════════════════════════════════════════════════════════════════════════════

import os from 'node:os';
import { createLogger } from '../logger.js';
import { childFailureText } from '../update/child-failure.js';
import { type OllamaHost, getOllamaHost } from './ollama-host.js';
import { heldOllamaVersion, noteUpkeep, upkeepRecord, isUnknownBuild, isVersionRefusal, ollamaAtLeast, readOllamaVersion, requiredOllamaVersion } from './ollama-version.js';
import {
  StepFailed, classifyOllama, desiredLoaded, endStuckStart, portOf, restartWithLimit, setLaunchdLimit, settleTakeover,
  retireDownloadedApp, startInstalled, startingNow, takeoverSettled, upkeepApp, upkeepServe, type Start,
} from './ollama-restart.js';
import {
  STANDARD_DECISION_MODEL, STANDARD_FLOOR_BYTES, STANDARD_PAIR_BYTES, STANDARD_TAGS, STANDARD_WRITER_MODEL,
  ensureLocalOllamaProvider, localOllamaProvider, ollamaJson, standardModelRowId,
} from './local-standard.js';
import { pullOllamaModel } from './ollama-pull.js';
import { downloadRoomRefusal } from '../update/disk-preflight.js';
import { getOllamaModelInfo } from './ollama.js';
import { computeAndStoreRecommendedNumCtx } from './num-ctx-calculator.js';
import { assignStandard, registerStandardRow, unregisterStandardRow } from './standard-model-rows.js';
import {
  OLLAMA_DOWN_WORDS, OLLAMA_LIMIT_FAILED_WORDS, OLLAMA_TOO_OLD_WORDS, STANDARD_MODELS_MISSING_WORDS, ownerConditionCleared, tellOwner,
} from '../healer/owner-notices.js';
import { ollamaAppLeftWords } from '../healer/local-model-notice-words.js';

const logger = createLogger('ollama-upkeep');
const NOTICE = 'ollama';
const RESIDENT = STANDARD_TAGS.length;
/** After an attempt that left the pair incomplete, the health door tries again at most this often. */
const RETRY_MS = 10 * 60_000;

export type UpkeepReason = 'setup' | 'boot' | 'repair' | 'health';
/** A minimum version; `'newer'` (the registry refused and named none: newer than the one running); null (no need). */
export type Need = string | 'newer' | null;
export interface UpgradeResult { ok: boolean; transient?: boolean; starting?: boolean; line?: string }

type Which = 'decision' | 'writer';
const MODEL = { decision: STANDARD_DECISION_MODEL, writer: STANDARD_WRITER_MODEL } as const;
const LABEL: Record<Which, string> = { decision: 'the decision model', writer: 'the writer' };
const CAPABILITIES: Record<Which, string[]> = { decision: ['decision'], writer: ['chat'] };

let running: Promise<UpgradeResult> | null = null;
let currentLine: string | null = null;
let modelLines: Partial<Record<Which, string>> = {};
let heldLine: string | null = null;
const pulling = new Set<Which>();
/** The step at which retiring the downloaded app failed; after a failure only a boot pass tries it again. */
let appFailed: Awaited<ReturnType<typeof retireDownloadedApp>> = null;

/** Run the upkeep. One run at a time: a caller with no version need joins the run under way; Repair and a caller with a
 *  need run after it, so each looks afresh. */
export function upkeep(reason: UpkeepReason, need: Need = null): Promise<UpgradeResult> {
  if (running && need === null && reason !== 'repair') return running;
  const run = (running ?? Promise.resolve()).then(() => keep(reason, need)).catch((err: unknown): UpgradeResult => {
    logger.warn('The Ollama upkeep failed', { reason, error: childFailureText(err) });
    return { ok: false, transient: true };
  });
  const tracked: Promise<UpgradeResult> = run.finally(() => { if (running === tracked) running = null; });
  running = tracked;
  return run;
}

/** Resolves when no upkeep is running. */
export async function upkeepSettled(): Promise<void> { while (running) await running; }

/** The health check's door: Ollama answered listing `listed`; the upkeep runs when the pair is not all in and registered. */
export function upkeepWhenIncomplete(listed: readonly string[], baseUrl: string): void {
  const local = localOllamaProvider();
  if (!local || local.baseUrl !== baseUrl.replace(/\/+$/, '')) return;
  const all = [...STANDARD_TAGS, STANDARD_DECISION_MODEL.windowTag].every((t) => listed.includes(t));
  if (!all || !standardModelRowId('writer') || !standardModelRowId('decision')) void upkeep('health');
}

async function keep(reason: UpkeepReason, need: Need): Promise<UpgradeResult> {
  const local = reason === 'setup' || reason === 'repair' ? ensureLocalOllamaProvider() : localOllamaProvider();
  if (!local) return { ok: false, transient: true };
  const host = getOllamaHost();
  const record = upkeepRecord();
  const heldRunning = reason === 'health' && record.held !== undefined && (await readOllamaVersion(local.baseUrl)) === record.held;
  if (reason === 'health' && (heldRunning || record.held === undefined) && record.triedAt !== undefined && Date.now() - record.triedAt < RETRY_MS) {
    return { ok: false, transient: true };
  }
  let current: UpgradeResult = { ok: false };
  if (!heldRunning) {
    current = await keepCurrent(host, local, need ?? requiredOllamaVersion(Object.values(MODEL)));
    currentLine = current.line ?? null; modelLines = {};
    if (current.ok && host) await keepLimit(host, local);
  }
  if (need !== null) return current;   // a refused pull of the owner's own model asks only for a newer Ollama
  const say = (which: Which, line: string): void => { modelLines[which] = line; };
  const ids: Record<Which, string | null> = { decision: null, writer: null };
  let listed = await listedTags(local.baseUrl);
  let upgradedOnRefusal = false;
  let noRoom: string | null = null;
  for (let i = 0; listed && i < 2; i++) {
    const which: Which = i === 0 ? 'decision' : 'writer';
    const { tag } = MODEL[which];
    if (!listed.has(tag)) {
      if (!current.ok && MODEL[which].minOllama) { unregisterStandardRow(local.id, tag); continue; }   // it waits for a newer Ollama
      const short = downloadRoomRefusal(MODEL[which].bytes);
      if (short !== null) { noRoom = short; say(which, short); unregisterStandardRow(local.id, tag); continue; }
      const error = await pull(which, local.baseUrl, say);
      if (error !== null && isVersionRefusal(error) && !upgradedOnRefusal) {
        upgradedOnRefusal = true;
        logger.warn('The registry refused a model: Ollama is too old', { error });
        current = await keepCurrent(host, local, 'newer');
        currentLine = current.line ?? currentLine;
        if (current.ok) { listed = await listedTags(local.baseUrl); i = -1; continue; }   // the whole pair again, on the new Ollama
      }
      if (error !== null) { unregisterStandardRow(local.id, tag); continue; }
    }
    say(which, `${LABEL[which][0].toUpperCase()}${LABEL[which].slice(1)} (${tag}) is installed.`);
    ids[which] = registerStandardRow(local.id, tag, CAPABILITIES[which], await getOllamaModelInfo(tag, local.baseUrl));
    await computeAndStoreRecommendedNumCtx(ids[which] as string).catch(() => null);
  }
  assignStandard(ids.writer, ids.decision);
  let windowMade = false;
  if (ids.decision) {
    const tag = await import('./decision-window.js');   // dynamic: the import graph's order
    windowMade = await (listed?.has(STANDARD_DECISION_MODEL.windowTag) ? tag.ensureDecisionWindowTag : tag.repairDecisionWindowTag)(local.baseUrl) !== null;
  }
  const complete = !!(ids.writer && ids.decision);
  noteUpkeep({ triedAt: (complete && windowMade) || !listed ? undefined : Date.now() });
  if (host && current.ok && (appFailed === null || reason === 'boot')) appFailed = await retireDownloadedApp(host, local.baseUrl);
  if (complete && current.ok && !upkeepRecord().limitOwed) { if (appFailed) tellOwner(NOTICE, ollamaAppLeftWords(appFailed)); else ownerConditionCleared(NOTICE); }
  else if (!complete && (current.ok || current.transient) && !current.starting) tellOwner(NOTICE, noRoom ?? STANDARD_MODELS_MISSING_WORDS);   // a failed upkeep told its own sentence
  return current;
}

const listedTags = async (baseUrl: string): Promise<Set<string> | null> => {
  const tags = await ollamaJson<{ models?: Array<{ name: string }> }>(baseUrl, '/api/tags');
  return tags ? new Set((tags.models ?? []).map((m) => m.name)) : null;
};

/** Pull one of the pair; null when Ollama lists it afterwards, else the failure (the registry's words go to the log only). */
async function pull(which: Which, baseUrl: string, say: (which: Which, line: string) => void): Promise<string | null> {
  const { tag } = MODEL[which];
  pulling.add(which);
  const outcome = await pullOllamaModel(tag, {
    baseUrl, onProgress: (p) => say(which, `Downloading ${LABEL[which]} (${tag}): ${p.total > 0 ? Math.floor((p.completed / p.total) * 100) : 0}%`),
  }).catch((err: unknown) => ({ ok: false as const, error: childFailureText(err) })).finally(() => pulling.delete(which));
  if (outcome.ok && (await listedTags(baseUrl))?.has(tag)) return null;
  const error = outcome.ok ? 'Ollama does not list it after the pull' : outcome.error;
  say(which, `Downloading ${LABEL[which]} (${tag}): failed. The log has the details.`);
  logger.warn('Standard model pull failed', { tag, error });
  return error;
}

/** Ollama runs current as a kind that lasts: its loaded-model limit is raised in launchd, and it is restarted once for it. */
async function keepLimit(host: OllamaHost, local: { id: string; baseUrl: string }): Promise<void> {
  try {
    const found = await classifyOllama(host, portOf(local.baseUrl));
    if (found?.kind !== 'app' && found?.kind !== 'brew-service') return;
    if (await setLaunchdLimit(host, RESIDENT) === null && !upkeepRecord().limitOwed) return;
    noteUpkeep({ limitOwed: true });   // owed until the restart has really happened
    await restartWithLimit(host, local, found, RESIDENT);
    noteUpkeep({ limitOwed: undefined });
    logger.info('Restarted the local Ollama to apply its loaded-model limit', { kind: found.kind });
  } catch (err) {
    logger.warn('Could not raise Ollama\'s loaded-model limit (non-fatal)', { error: childFailureText(err) });
    noteUpkeep({ limitOwed: true });   // the next start tries again
    tellOwner(NOTICE, OLLAMA_LIMIT_FAILED_WORDS);
  }
}

const WHY: Record<StepFailed['step'], string> = {
  install: 'Homebrew could not install the newer Ollama.',
  stop: 'it runs as another user or as the system, so the Dojo cannot stop it.',
  again: 'something on this Mac starts the old Ollama again whenever it stops.',
  start: 'it did not start again after the update.',
};

/** Make the Ollama running on this box meet `need`, running as a kind that lasts, whoever started it. */
async function keepCurrent(host: OllamaHost | null, local: { id: string; baseUrl: string }, need: Need): Promise<UpgradeResult> {
  if (host && await endStuckStart(host, local.baseUrl, RESIDENT) === 'dead') {
    tellOwner(NOTICE, OLLAMA_DOWN_WORDS);
    return { ok: false, line: 'Ollama was started but never answered, and nothing else on this Mac can run it now. The Dojo tries again at its next start.' };
  }
  const port = portOf(local.baseUrl);
  let here = host ? await classifyOllama(host, port) : null;
  if (host && !here) {
    const started = await startInstalled(host, local.baseUrl, RESIDENT);
    if (started === 'answering') here = await classifyOllama(host, port);
    if (started === 'starting') noteUpkeep({ starting: await startingNow(host) });
    if (!here) return started === 'starting' ? { ok: false, transient: true, starting: true, line: 'Ollama is starting.' } : { ok: false, transient: true, line: 'Ollama is not running, and the Dojo could not start it at that moment.' };
  }
  const before = await readOllamaVersion(local.baseUrl);
  const meets = (v: string | null): boolean => (need === 'newer' ? v !== null && v !== before : need === null || v === null || isUnknownBuild(v) || ollamaAtLeast(v, need));
  const stale = need === 'newer' || !meets(before);
  const ok = (line?: string): UpgradeResult => {
    if (heldOllamaVersion() !== null) { heldLine = null; ownerConditionCleared(NOTICE); }   // the notice ends where the hold does
    noteUpkeep({ starting: undefined, held: undefined });
    return { ok: true, line };
  };
  const tooOld = !stale ? '' : `Ollama ${before ?? '(unknown version)'} is older than ${need === 'newer' ? 'the model needs' : `the Dojo's models need (${need})`}. `;
  const cannot = (why: string): UpgradeResult => {
    logger.warn('The Dojo could not update or take over the local Ollama', { kind: here?.kind, have: before, need, why });
    if (!stale) return ok();   // it serves what the models need; only the limit and lasting past a Dojo restart are missing
    heldLine = `${tooOld}The Dojo could not update it: ${why}`;
    noteUpkeep({ held: before ?? 'unknown' });
    tellOwner(NOTICE, OLLAMA_TOO_OLD_WORDS);   // the one action sentence: the owner's notices take its class from the hold
    return { ok: false, line: heldLine };
  };
  if (!host || !here) return cannot('the Dojo cannot run commands on this machine.');
  const found = here;
  if (found.kind === 'not-ollama') return cannot(`the program answering on Ollama's port is not Ollama (${found.path.split('/').pop()}), so the Dojo leaves it alone.`);
  const lasts = found.kind === 'app' || found.kind === 'brew-service';
  if (!stale && (lasts || isUnknownBuild(before) || takeoverSettled(found, desiredLoaded(RESIDENT)))) return ok();
  if (!await host.hasBrew()) return cannot('Homebrew is not installed on this Mac.');
  let started: Start;
  try {
    started = found.kind === 'app' ? await upkeepApp(host, local, found.pid, RESIDENT) : await upkeepServe(host, local, found, stale, meets, RESIDENT);
    if (started !== 'dead') noteUpkeep({ limitOwed: undefined });   // the restart carried the limit
  } catch (err) {
    const step = err instanceof StepFailed ? err.step : 'start';
    logger.warn('The Ollama upkeep did not complete', { kind: found.kind, step, error: childFailureText(err) });
    if (step === 'stop' && !stale) { settleTakeover(found); return ok(); }   // another user's current Ollama: left serving, never stopped again
    if (step !== 'install' && !await host.answers(local.baseUrl) && (await host.listener(port)) === null) started = 'dead';
    else return cannot(WHY[step]);
  }
  if (started === 'dead') {
    tellOwner(NOTICE, OLLAMA_DOWN_WORDS);
    return { ok: false, line: `${tooOld}Ollama stopped while the Dojo was updating it and has not come back yet.` };
  }
  if (started === 'starting') { noteUpkeep({ starting: await startingNow(host) }); return { ok: false, transient: true, starting: true, line: 'Ollama is starting again after the update.' }; }
  const after = await readOllamaVersion(local.baseUrl);
  if (!meets(after)) return cannot(after === before ? 'Homebrew has no newer Ollama to install.' : `it is still on ${after ?? 'an unknown version'}.`);
  const now = await classifyOllama(host, port);
  logger.info('The local Ollama is current', { kind: now?.kind, before, after });
  return ok(stale ? `Updated ${now?.kind === 'app' ? 'the Ollama app' : 'Ollama (installed with Homebrew)'} from ${before ?? 'an older version'} to ${after} and restarted it.` : undefined);
}

type Presence = 'installed' | 'missing' | 'pulling';
export interface StandardState { decision: Presence; writer: Presence; ollama: 'running' | 'stopped' | 'absent'; residentBytes: number; note: string }

function noteFor(s: Omit<StandardState, 'note'>): string {
  if (s.ollama !== 'running') {
    return s.ollama === 'absent' ? "Ollama is not set up on this box yet, so the Dojo's two models cannot be installed."
      : "Ollama is not running, so the Dojo's two models cannot be checked or installed.";
  }
  if (s.decision === 'pulling' || s.writer === 'pulling') return "Installing the Dojo's two models.";
  const missing = (['decision', 'writer'] as const).filter((w) => s[w] === 'missing');
  if (missing.length > 0) {
    if (heldOllamaVersion() !== null && heldLine) return `Not installed yet: ${missing.map((w) => LABEL[w]).join(' and ')}. ${heldLine} Repair tries again.`;
    return `Not installed yet: ${missing.map((w) => `${LABEL[w]} (${MODEL[w].tag})`).join(' and ')}. Use Repair to install it.`;
  }
  const total = os.totalmem();
  if (total < STANDARD_FLOOR_BYTES) {
    return `This box has ${Math.round(total / 1024 ** 3)} GB; the Dojo's two models need about ${Math.round(STANDARD_PAIR_BYTES / 1e9)} GB `
      + 'of memory beside the desktop and the engine, so a local agent model will not fit alongside them.';
  }
  return `Both standard models are installed (${(STANDARD_PAIR_BYTES / 1e9).toFixed(1)} GB).`;
}

/** What this box has of the pair right now (an upkeep under way reads "installing"). Never throws. */
export async function standardState(): Promise<StandardState> {
  const provider = localOllamaProvider();
  const baseUrl = provider?.baseUrl ?? 'http://localhost:11434';
  const installed = await listedTags(baseUrl);
  const presence = (w: Which): Presence => (installed?.has(MODEL[w].tag) && !pulling.has(w) ? 'installed' : pulling.has(w) || running ? 'pulling' : 'missing');
  const ps = installed ? await ollamaJson<{ models?: Array<{ name: string; size?: number }> }>(baseUrl, '/api/ps') : null;
  const residentBytes = (ps?.models ?? []).filter((m) => STANDARD_TAGS.includes(m.name) || m.name === STANDARD_DECISION_MODEL.windowTag)
    .reduce((sum, m) => sum + (typeof m.size === 'number' ? m.size : 0), 0);
  const base = { decision: presence('decision'), writer: presence('writer'), ollama: installed ? 'running' as const : provider ? 'stopped' as const : 'absent' as const, residentBytes };
  return { ...base, note: noteFor(base) };
}

/** The progress lines of the upkeep running now (or the last one), for the setup screen and the tile. */
export const standardProgressLines = (): readonly string[] =>
  [...(currentLine ? [currentLine] : []), ...(['decision', 'writer'] as const).flatMap((w) => modelLines[w] ?? [])];
