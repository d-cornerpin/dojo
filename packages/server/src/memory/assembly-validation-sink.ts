// ════════════════════════════════════════════════════════════════════════════════════════
// THE DURABLE DIVERGENCE SINK. PHASE-3 T5, orchestrator opening rider.
//
// ── WHY THIS FILE EXISTS, MEASURED ──────────────────────────────────────────────────────
// T4 opened a 7-CALENDAR-DAY detect-only window (2026-07-31 → 2026-08-07, dojo `b6699c9`)
// whose day-7 verdict is read from `validateAtProviderBoundary`'s own log lines. Those
// lines went to `~/.dojo/logs/dojo.log`, which `logger.ts:48-66` rotates at 10MB keeping
// exactly ONE backup. Re-derived at T5's HEAD (`ababf11`) by command, 2026-08-01T04:12Z:
//
//   dojo.log.1   19,081,331 bytes   03:56:01.221Z → 04:00:33.948Z    4m 33s
//   dojo.log      4,265,426 bytes   04:00:33.564Z → 04:12:15.073Z   11m 42s
//                                   ───────────────────────────────────────
//                                   total retained history          16m 14s
//
// Under the traffic the rotated file recorded, retention is under five minutes. T4's own
// 17 day-0 divergence lines were ALREADY UNRECOVERABLE when this task opened —
// `grep -c ASSEMBLY_VALIDATION_DIVERGENCE` over BOTH files returned 0. A seven-day window
// whose evidence lives in a file with minutes of retention cannot answer its own question.
//
// The in-process counters have the second half of the same problem: `tsx watch` restarts
// on every source save, so `checked`/`diverged` describe the last few minutes of the last
// build. That is deliberate and stays — a counter persisted across a deploy would blur two
// different builds — which is exactly why every record below carries its `pid`.
//
// ── WHAT IT IS ──────────────────────────────────────────────────────────────────────────
//   ~/.dojo/logs/assembly-validation.jsonl
//
// Append-only. One JSON object per DIVERGENCE — never a heartbeat, never a clean call — so
// the file is tiny by construction and its LINE COUNT IS THE INCIDENT COUNT. `logger.ts`'s
// rotation names `dojo.log` and nothing else, so this file is exempt from rotation by
// construction rather than by configuration, and a test pins that.
//
// ── TO READ THE WINDOW ON DAY 7 (all four, in this order) ───────────────────────────────
//   wc -l ~/.dojo/logs/assembly-validation.jsonl                     # incidents, whole window
//   jq -r '.codes[]' ~/.dojo/logs/assembly-validation.jsonl | sort | uniq -c | sort -rn
//                                                                    # what actually diverged
//   jq -s 'group_by(.pid)|map({pid:.[0].pid,lastChecked:(max_by(.checked).checked),
//          diverged:length})' ~/.dojo/logs/assembly-validation.jsonl  # denominators, per build
//   grep ASSEMBLY_VALIDATION_HEARTBEAT ~/.dojo/logs/dojo.log | tail -1
//                                                                    # the validator is alive NOW
//
// An ABSENT or EMPTY sink is good news ONLY together with a heartbeat: absence on its own
// is ambiguous between "a clean week" and "the writer never worked", and inferring health
// from absence is the reasoning roadmap #15 exists to forbid. A write that fails is
// therefore COUNTED (`assemblyValidationSinkFailures()`) and logged once per process under
// ASSEMBLY_VALIDATION_SINK_UNAVAILABLE — never swallowed.
//
// ── WHY IT IS ITS OWN MODULE ────────────────────────────────────────────────────────────
// One owner per job: `assembly-validation.ts` DECIDES, this file PERSISTS. The split is
// also what the size ratchet asked for — `assembly-validation.ts` is pinned at 561 lines
// and this mechanism would have pushed it to 692, and a hand-raised ceiling to hold a
// separable concern is the adding-without-deleting shape the gate exists to slow down.
// ════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../logger.js';
import type { AssemblyValidationMode } from './assembly-validation.js';

const logger = createLogger('assembly-validation-sink');

export const ASSEMBLY_VALIDATION_SINK_FILENAME = 'assembly-validation.jsonl';

/** Resolved per call, never cached: tests redirect `HOME`, and a cached path ignores them. */
export function assemblyValidationSinkPath(): string {
  return path.join(os.homedir(), '.dojo', 'logs', ASSEMBLY_VALIDATION_SINK_FILENAME);
}

export interface DivergenceRecord {
  /** ISO-8601. */
  at: string;
  /** Which process — `checked`/`diverged` are only comparable WITHIN one. Never sum across. */
  pid: number;
  mode: AssemblyValidationMode;
  agentId: string;
  modelId: string;
  codes: string[];
  /** `code: detail`, one per violation — the codes alone do not say WHICH message. */
  violations: string[];
  tokenTotal: number;
  budgetTokens: number;
  overBy: number;
  messageCount: number;
  checked: number;
  diverged: number;
}

let sinkFailures = 0;
let sinkFailureReported = false;

export function assemblyValidationSinkFailures(): number {
  return sinkFailures;
}

/** Reset for tests. Never called in production. */
export function __resetAssemblyValidationSinkFailures(): void {
  sinkFailures = 0;
  sinkFailureReported = false;
}

/**
 * Append one divergence. SYNCHRONOUS on purpose: divergences are rare (17 in T4's first
 * live hour) and the entire point of this file is that the record is on disk before the
 * process can be restarted out from under it — which, on a `tsx watch` box, is every time
 * anyone saves a source file. Never throws: a turn must not die because a log file is
 * unwritable. Never silent either: the failure is counted and reported once.
 */
export function appendDivergenceRecord(record: DivergenceRecord): void {
  const file = assemblyValidationSinkPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    sinkFailures++;
    if (!sinkFailureReported) {
      sinkFailureReported = true;
      logger.error(
        `ASSEMBLY_VALIDATION_SINK_UNAVAILABLE path=${file} — the detect window's durable ` +
        `evidence is NOT being written; an empty sink must not be read as a clean week`,
        { path: file, error: err instanceof Error ? err.message : String(err) },
      );
    }
  }
}

/** Read the sink back. A torn last line is skipped rather than losing the whole window. */
export function readAssemblyValidationSink(
  file: string = assemblyValidationSinkPath(),
): DivergenceRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: DivergenceRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DivergenceRecord);
    } catch {
      /* a torn last line is not a reason to lose the window */
    }
  }
  return out;
}
