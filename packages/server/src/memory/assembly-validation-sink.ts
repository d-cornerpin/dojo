// Durable record of assembly-validation divergences: ~/.dojo/logs/assembly-validation.jsonl.
// Append-only, one JSON line per divergence (never a heartbeat), so the line count is the incident
// count. It is not dojo.log because logger.ts rotates only that file, keeping one backup.
// An empty sink means a clean run only together with a heartbeat; a failed write is counted and
// logged once, never swallowed. assembly-validation.ts decides, this file persists.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';
import type { AssemblyValidationMode } from './assembly-validation.js';
import { homeDir } from '../home.js';

const logger = createLogger('assembly-validation-sink');

export const ASSEMBLY_VALIDATION_SINK_FILENAME = 'assembly-validation.jsonl';

/** Resolved per call, never cached: tests redirect `HOME`, and a cached path ignores them. */
export function assemblyValidationSinkPath(): string {
  return path.join(homeDir(), '.dojo', 'logs', ASSEMBLY_VALIDATION_SINK_FILENAME);
}

export interface DivergenceRecord {
  at: string;
  /** Which process: `checked`/`diverged` are only comparable within one. Never sum across. */
  pid: number;
  mode: AssemblyValidationMode;
  agentId: string;
  modelId: string;
  codes: string[];
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

export function __resetAssemblyValidationSinkFailures(): void {
  sinkFailures = 0;
  sinkFailureReported = false;
}

/**
 * Append one divergence. Synchronous so the record is on disk before a restart can lose it.
 * Never throws (a turn must not die on an unwritable log), never silent (the failure is counted).
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
