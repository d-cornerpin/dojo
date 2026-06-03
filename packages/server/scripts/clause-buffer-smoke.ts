#!/usr/bin/env tsx
/**
 * Smoke-check StreamingSpeechBuffer.pushClauses — Phase 4 boundary logic.
 *
 * Walks a few representative streaming sequences and asserts that the
 * buffer flushes the right clauses at the right time. Aimed at catching
 * regressions where a tweak to the boundary regex starts emitting clauses
 * too early (choppy audio) or too late (latency back to sentence-level).
 */

import { StreamingSpeechBuffer } from '../src/voice/text-sanitize.js';

interface Case {
  name: string;
  chunks: string[];
  /** Expected ready clauses in order, ignoring flushUnsafe (separate column). */
  expected: string[];
  /** Expected leftover after flushUnsafe at the end. */
  expectedTail: string;
}

const cases: Case[] = [
  {
    name: 'short reply: no early flush',
    chunks: ['Sure.'],
    expected: [],
    expectedTail: 'Sure.',
  },
  {
    name: 'first sentence past minLen flushes, short tail stays buffered',
    chunks: [
      'Yes, I can absolutely do that for you.',
      ' Just one moment please.',
    ],
    expected: ['Yes, I can absolutely do that for you.'],
    expectedTail: 'Just one moment please.',
  },
  {
    name: 'short complete reply stays buffered until flushUnsafe',
    chunks: [
      'Yes I can do that for you.',
    ],
    expected: [],
    expectedTail: 'Yes I can do that for you.',
  },
  {
    name: 'mid-sentence comma triggers clause split past minLen',
    chunks: [
      'I went to the store earlier today, and bought some milk on the way back.',
    ],
    // Comma after "today" is at char ~32 — clause length 33 > minLen 30. Split.
    expected: ['I went to the store earlier today,'],
    expectedTail: 'and bought some milk on the way back.',
  },
  {
    name: 'streaming tokens: clause emerges as buffer crosses threshold',
    chunks: [
      'The router is',
      ' connected to the modem,',
      ' which is on the desk.',
    ],
    // After all three chunks combined: "The router is connected to the modem, which is on the desk."
    // First boundary >= 30: "," after "modem" at length 38. Then the period at end with no trailing space → defer.
    expected: ['The router is connected to the modem,'],
    expectedTail: 'which is on the desk.',
  },
  {
    name: 'unbalanced markdown holds boundary back',
    chunks: [
      'Here is a **bold thing in progress',
      ' that finishes** now. Then more text after that boundary.',
    ],
    // The first ** is unbalanced until the second ** arrives. After that the
    // ". " after "now" should be the first boundary post-minLen.
    expected: ['Here is a bold thing in progress that finishes now.'],
    expectedTail: 'Then more text after that boundary.',
  },
];

let failures = 0;
for (const tc of cases) {
  const buf = new StreamingSpeechBuffer();
  const got: string[] = [];
  for (const ch of tc.chunks) {
    got.push(...buf.pushClauses(ch));
  }
  const tail = buf.flushUnsafe();
  const ok =
    JSON.stringify(got) === JSON.stringify(tc.expected) &&
    tail.trim() === tc.expectedTail.trim();
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${tc.name}`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(tc.expected)}  tail=${JSON.stringify(tc.expectedTail)}`);
    console.log(`  got     : ${JSON.stringify(got)}  tail=${JSON.stringify(tail.trim())}`);
    failures++;
  }
}

if (failures > 0) {
  console.log(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
process.exit(0);
