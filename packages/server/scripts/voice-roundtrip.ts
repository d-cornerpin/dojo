#!/usr/bin/env tsx
/**
 * Voice round-trip / STT engine comparison.
 *
 * Synthesizes a small fixture set via Kokoro (so the script is
 * self-contained — no microphone, no external assets), then transcribes
 * each fixture through both the Moonshine engine and the Whisper engine,
 * logging WER and wall-clock final-STT latency side by side.
 *
 * Usage (from the platform repo root):
 *   npx tsx packages/server/scripts/voice-roundtrip.ts
 *
 * Flags:
 *   --moonshine-only      Run only the Moonshine engine (skip Whisper).
 *   --whisper-only        Run only the Whisper engine.
 *   --whisper-size=<size> Whisper size to use (default: large-v3-turbo).
 *
 * First run downloads any missing models. Subsequent runs are fast.
 *
 * The fixtures cover the cases the v2.9 plan calls out:
 *   - short utterance
 *   - long utterance
 *   - utterance with backchannels (filler words)
 *   - proper nouns
 *   - numerics (units, times, ranges)
 *
 * Note: synthesizing fixtures via Kokoro means both engines are tested on
 * the SAME audio, which is fair but slightly biased toward how Kokoro
 * sounds. For real-world validation the user should also record a few
 * WAVs themselves and run them through voice mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { synthesizeOnce } from '../src/voice/tts-service.js';
import {
  transcribeBuffer,
  ensureSttReady,
  stopWhisperServer,
  DEFAULT_STT_MODEL_KEY,
} from '../src/voice/stt-service.js';
import type { WhisperSize } from '../src/voice/model-manager.js';

const FIXTURES: Array<{ id: string; reference: string; note: string }> = [
  {
    id: 'short',
    reference: 'What time is it.',
    note: 'short utterance',
  },
  {
    id: 'medium',
    reference: 'Can you remind me to call the dentist tomorrow afternoon.',
    note: 'medium-length conversational',
  },
  {
    id: 'long',
    reference:
      'I need you to draft a short reply to my last email, keep it casual, ' +
      'and make sure to thank them for the update and confirm I can meet ' +
      'on Thursday morning at the regular coffee shop.',
    note: 'long utterance',
  },
  {
    id: 'backchannels',
    reference: 'Yeah right so umm I think we should probably just move on okay.',
    note: 'backchannels and fillers (yeah, right, umm)',
  },
  {
    id: 'proper_nouns',
    reference: 'Tell Alex to meet Jordan at the Tacoma Dome on Saturday.',
    note: 'proper nouns and place names',
  },
  {
    id: 'numerics',
    reference:
      'Schedule a thirty minute meeting at three thirty PM tomorrow, and ' +
      'remind me again at five oclock.',
    note: 'numerics, times, and durations',
  },
  {
    id: 'mixed_case',
    reference:
      'Open the dashboard, find the task titled review Q3 numbers, and mark ' +
      'it complete.',
    note: 'mixed case + multi-clause command',
  },
];

interface RunResult {
  fixture: string;
  reference: string;
  text: string;
  wallMs: number;
  internalMs: number;
  wer: number;
}

interface EngineSummary {
  engine: string;
  results: RunResult[];
  meanWer: number;
  meanWallMs: number;
  medianWallMs: number;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Word-level edit distance / WER. Standard Levenshtein over token arrays
 * divided by reference token count. 0 = perfect; >= 1 means we lost more
 * words than the reference had.
 */
function wer(reference: string, hypothesis: string): number {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const dp: number[][] = Array.from({ length: ref.length + 1 }, () =>
    new Array(hyp.length + 1).fill(0),
  );
  for (let i = 0; i <= ref.length; i++) dp[i][0] = i;
  for (let j = 0; j <= hyp.length; j++) dp[0][j] = j;
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,           // deletion
        dp[i][j - 1] + 1,           // insertion
        dp[i - 1][j - 1] + cost,    // substitution
      );
    }
  }
  return dp[ref.length][hyp.length] / ref.length;
}

async function synthesizeFixtures(outDir: string): Promise<Array<{ id: string; reference: string; wavPath: string }>> {
  fs.mkdirSync(outDir, { recursive: true });
  const out: Array<{ id: string; reference: string; wavPath: string }> = [];
  for (const f of FIXTURES) {
    const wavPath = path.join(outDir, `${f.id}.wav`);
    if (!fs.existsSync(wavPath)) {
      console.log(`[voice-rt] synthesizing fixture ${f.id} (${f.note})...`);
      const r = await synthesizeOnce(f.reference);
      fs.writeFileSync(wavPath, r.wav);
    }
    out.push({ id: f.id, reference: f.reference, wavPath });
  }
  return out;
}

async function runEngine(
  engineKey: string,
  fixtures: Array<{ id: string; reference: string; wavPath: string }>,
): Promise<EngineSummary> {
  console.log(`\n[voice-rt] === ${engineKey} ===`);
  console.log(`[voice-rt] warming up...`);
  const warmStart = Date.now();
  await ensureSttReady(engineKey);
  console.log(`[voice-rt] warm-up: ${Date.now() - warmStart}ms`);
  const results: RunResult[] = [];
  for (const f of fixtures) {
    const wav = fs.readFileSync(f.wavPath);
    const start = Date.now();
    const r = await transcribeBuffer(wav, { modelKey: engineKey });
    const wallMs = Date.now() - start;
    const e = wer(f.reference, r.text);
    results.push({
      fixture: f.id,
      reference: f.reference,
      text: r.text,
      wallMs,
      internalMs: r.durationMs,
      wer: e,
    });
    console.log(
      `[voice-rt] ${f.id.padEnd(14)} WER=${e.toFixed(2)} wall=${String(wallMs).padStart(4)}ms ` +
      `internal=${String(r.durationMs).padStart(4)}ms`,
    );
    console.log(`             ref:  "${f.reference}"`);
    console.log(`             text: "${r.text}"`);
  }
  const wallMsList = results.map((r) => r.wallMs).sort((a, b) => a - b);
  const median = wallMsList.length % 2 === 1
    ? wallMsList[Math.floor(wallMsList.length / 2)]
    : Math.round((wallMsList[wallMsList.length / 2 - 1] + wallMsList[wallMsList.length / 2]) / 2);
  return {
    engine: engineKey,
    results,
    meanWer: results.reduce((s, r) => s + r.wer, 0) / results.length,
    meanWallMs: results.reduce((s, r) => s + r.wallMs, 0) / results.length,
    medianWallMs: median,
  };
}

function printSummary(summaries: EngineSummary[]): void {
  console.log('\n[voice-rt] === SUMMARY ===');
  console.log(
    [
      'engine'.padEnd(20),
      'mean WER',
      'mean wall ms',
      'median wall ms',
    ].join('  '),
  );
  for (const s of summaries) {
    console.log(
      [
        s.engine.padEnd(20),
        s.meanWer.toFixed(3).padStart(8),
        s.meanWallMs.toFixed(0).padStart(12),
        String(s.medianWallMs).padStart(14),
      ].join('  '),
    );
  }
  if (summaries.length >= 2) {
    const a = summaries[0];
    const b = summaries[1];
    const werDelta = ((a.meanWer - b.meanWer) * 100).toFixed(1);
    const wallDelta = (b.medianWallMs - a.medianWallMs).toFixed(0);
    console.log(`\n[voice-rt] ${b.engine} vs ${a.engine}:`);
    console.log(`[voice-rt]   WER diff: ${werDelta} percentage points (negative = ${b.engine} better)`);
    console.log(`[voice-rt]   median wall ms diff: ${wallDelta}ms (positive = ${b.engine} slower)`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const moonshineOnly = args.includes('--moonshine-only');
  const whisperOnly = args.includes('--whisper-only');
  const whisperSizeArg = args.find((a) => a.startsWith('--whisper-size='));
  const whisperSize = (whisperSizeArg
    ? whisperSizeArg.slice('--whisper-size='.length)
    : 'large-v3-turbo') as WhisperSize;

  const fixtureDir = path.join(os.tmpdir(), 'dojo-voice-rt-fixtures');
  console.log(`[voice-rt] fixture dir: ${fixtureDir}`);

  const fixtures = await synthesizeFixtures(fixtureDir);

  const summaries: EngineSummary[] = [];

  if (!whisperOnly) {
    summaries.push(await runEngine(DEFAULT_STT_MODEL_KEY, fixtures));
  }
  if (!moonshineOnly) {
    // Drop the Moonshine engine before warming Whisper so we honour the
    // single-resident invariant. ensureSttReady on a new key does this
    // automatically; the explicit call here just makes intent obvious.
    summaries.push(await runEngine(whisperSize, fixtures));
  }

  printSummary(summaries);

  await stopWhisperServer().catch(() => { /* noop */ });
  process.exit(0);
}

main().catch((err) => {
  console.error('[voice-rt] ERROR:', err);
  process.exit(2);
});
