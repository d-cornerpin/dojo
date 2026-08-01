// ════════════════════════════════════════════════════════════════════════════════════════
// THE RE-ANSWER DETECTOR'S DURABLE SINK. PHASE-3 T7 Step 2 (the quiet window opens here).
//
// ── WHAT THE WINDOW IS FOR ──────────────────────────────────────────────────────────────
// Research 18 §open-1 item 2 (the "4c strips", pre-adjudicated, do not re-derive): the
// SETTLED_HINT, the settled-HOLD carve-out flags and the cross-conversation echo ROWS are
// all band-aids for one disease — an agent re-answering a settled conversation's question.
// The ledger's verdict names the instrument that licenses their removal:
//
//     "The log-only re-answer detector IS the validation instrument … detector deletes
//      after quiet period."
//
// So the strip is gated on the detector staying QUIET for 7 calendar days on a build that
// has the deliveries lane (T7 Step 1) — and then the detector itself is deleted (PHASE-3.md
// T7 Step 2; T9's exit gate greps for it).
//
// ── WHY THIS FILE HAD TO EXIST BEFORE THE WINDOW COULD OPEN ─────────────────────────────
// The detector has been live and log-only since 2026-07-10, writing one `logger.warn` per
// firing into `~/.dojo/logs/dojo.log`. T5 measured what that file retains (`logger.ts`
// rotates at 10MB keeping ONE backup): 16 MINUTES 14 SECONDS of total history under real
// traffic, and T4's own 17 divergence lines were already unrecoverable when T5 looked. The
// same arithmetic applies to this window exactly as it did to T4's, and RE-DERIVED at T7's
// own HEAD (2026-08-01T06:55Z, by reading the first and last record of each file):
//
//   dojo.log.1   19,522,717 bytes   06:51:12.869Z → 06:52:14.145Z    1m 01s
//   dojo.log      6,635,551 bytes   06:52:14.124Z → 06:55:27.542Z    3m 13s
//                                   ───────────────────────────────────────
//                                   total retained history           4m 15s
//
// It had not improved; under that afternoon's traffic it was four times worse.
//
// A SEVEN-DAY WINDOW WHOSE EVIDENCE LIVES IN A FILE WITH MINUTES OF RETENTION CANNOT ANSWER
// ITS OWN QUESTION. Worse, it fails in the direction that licenses a deletion: an empty
// `grep` reads as "quiet week" when it may only mean "rotated away".
//
// ── WHAT IT IS ──────────────────────────────────────────────────────────────────────────
//   ~/.dojo/logs/re-answer-detector.jsonl
//
// Append-only, one JSON object per line, two kinds:
//
//   {"kind":"fire", …}       the detector matched. One per firing. In a quiet week there
//                            are ZERO of these, which is the whole point.
//   {"kind":"heartbeat", …}  THE DENOMINATOR. Written on a process's FIRST check and every
//                            HEARTBEAT_EVERY checks after it, so the file always answers
//                            "how many replies were examined" and not only "how many
//                            matched". Quiet is then distinguishable from never-ran INSIDE
//                            the durable evidence, with no live instrument to consult —
//                            which is the one thing T4's design could not do (its heartbeat
//                            went to the rotating log, and T6 had to add a kit route to
//                            recover the denominator at all).
//
// `logger.ts`'s rotation names `dojo.log` and nothing else, so this file is exempt from
// rotation by construction rather than by configuration.
//
// ── TO READ THE WINDOW (all four, in this order) ────────────────────────────────────────
//   grep -c '"kind":"fire"' ~/.dojo/logs/re-answer-detector.jsonl        # incidents
//   jq -s '[.[]|select(.kind=="heartbeat")]|group_by(.pid)|map({pid:.[0].pid,
//          checked:(max_by(.checked).checked)})' ~/.dojo/logs/re-answer-detector.jsonl
//                                                                        # denominator per build
//   jq -r 'select(.kind=="fire")|[.at,.agentId,.similarity,.matchConv]|@tsv'
//          ~/.dojo/logs/re-answer-detector.jsonl                         # what fired, if anything
//   tail -1 ~/.dojo/logs/re-answer-detector.jsonl                        # the detector is alive NOW
//
// A file that does not exist is NOT a quiet week — it is a window that never ran, and
// inferring health from absence is the reasoning roadmap #15 exists to forbid. A write that
// fails is therefore COUNTED (`reAnswerSinkFailures()`) and logged once per process under
// RE_ANSWER_SINK_UNAVAILABLE, never swallowed.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────────────────
// It does not change the detector's behaviour, which is already log-only by a 2026-07-10
// decision recorded at its call site (the steer version false-positived on legitimately
// recurring content). Making it quieter or louder mid-window would measure a different
// thing than the window is asking about.
//
// It is also a SIBLING of `memory/assembly-validation-sink.ts` rather than a shared helper.
// The two are the same shape and that is visible; unifying them means editing the sink that
// T4's live detect window is currently writing to, which this task is fenced off. The
// unification is enumerated for T9 (or the phase that deletes this file with the detector,
// whichever comes first) — recorded here so the duplication is a decision with a date on
// it, not an oversight.
// ════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../../logger.js';

const logger = createLogger('re-answer-sink');

export const RE_ANSWER_SINK_FILENAME = 're-answer-detector.jsonl';

/** How often a heartbeat lands. Small on purpose: the sink's whole job is to carry a
 *  denominator through a `tsx watch` restart, and at one line per 20 checks a week of real
 *  traffic is still a few kilobytes. T4's 200-call heartbeat was never reached by a scenario
 *  run at all, which is exactly the failure this number is chosen against. */
export const HEARTBEAT_EVERY = 20;

/** Resolved per call, never cached: tests redirect `HOME`, and a cached path ignores them. */
export function reAnswerSinkPath(): string {
  return path.join(os.homedir(), '.dojo', 'logs', RE_ANSWER_SINK_FILENAME);
}

export interface ReAnswerCheck {
  agentId: string;
  turnNumber: number | null;
  /** The conversation this turn served (excluded from the comparison by the detector). */
  convKey: string | null;
  /** Null when the detector did NOT match — the quiet case, which is most of them. */
  match: { conversationId: string; similarity: number; snippet: string } | null;
  /** Length of the reply that was examined; the detector's own floor is 160 chars. */
  replyChars: number;
}

export interface ReAnswerRecord {
  kind: 'fire' | 'heartbeat';
  /** ISO-8601. */
  at: string;
  /** Which process — `checked`/`fired` are only comparable WITHIN one. Never sum across. */
  pid: number;
  /** Checks this process has performed, INCLUDING this one. The denominator. */
  checked: number;
  /** Firings this process has recorded, including this one when `kind` is `fire`. */
  fired: number;
  agentId: string;
  turnNumber: number | null;
  convKey: string | null;
  replyChars: number;
  /** Present only on a `fire`. */
  matchConv?: string;
  similarity?: number;
  snippet?: string;
}

let checked = 0;
let fired = 0;
let sinkFailures = 0;
let sinkFailureReported = false;

export function reAnswerCounters(): { checked: number; fired: number } {
  return { checked, fired };
}
export function reAnswerSinkFailures(): number {
  return sinkFailures;
}

/** Reset for tests. Never called in production. */
export function __resetReAnswerSink(): void {
  checked = 0;
  fired = 0;
  sinkFailures = 0;
  sinkFailureReported = false;
}

function append(record: ReAnswerRecord): void {
  const file = reAnswerSinkPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    sinkFailures++;
    if (!sinkFailureReported) {
      sinkFailureReported = true;
      logger.error(
        `RE_ANSWER_SINK_UNAVAILABLE path=${file} — the quiet window's durable evidence is ` +
        `NOT being written; an absent or short file must not be read as a quiet week`,
        { path: file, error: err instanceof Error ? err.message : String(err) },
      );
    }
  }
}

/**
 * Record ONE detector check. Called on every examined reply, matched or not — that is what
 * makes the file a measurement rather than an anecdote.
 *
 * SYNCHRONOUS on purpose, same reasoning as the assembly-validation sink: the record has to
 * be on disk before `tsx watch` can restart the process out from under it, which on this box
 * is every time anyone saves a source file. Never throws — a turn must not die because a log
 * file is unwritable — and never silent: the failure is counted and reported once.
 */
export function recordReAnswerCheck(check: ReAnswerCheck): void {
  checked++;
  const heartbeatDue = checked === 1 || checked % HEARTBEAT_EVERY === 0;
  if (check.match) fired++;
  if (!check.match && !heartbeatDue) return;

  const base: ReAnswerRecord = {
    kind: check.match ? 'fire' : 'heartbeat',
    at: new Date().toISOString(),
    pid: process.pid,
    checked,
    fired,
    agentId: check.agentId,
    turnNumber: check.turnNumber,
    convKey: check.convKey,
    replyChars: check.replyChars,
  };
  append(check.match
    ? { ...base, matchConv: check.match.conversationId, similarity: check.match.similarity, snippet: check.match.snippet }
    : base);
}

/** Read the sink back. A torn last line is skipped rather than losing the whole window. */
export function readReAnswerSink(file: string = reAnswerSinkPath()): ReAnswerRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: ReAnswerRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ReAnswerRecord);
    } catch {
      /* a torn last line is not a reason to lose the window */
    }
  }
  return out;
}
