#!/usr/bin/env tsx
/**
 * Smoke-check the delivery-cue parser. Quick assertions over the cases
 * that matter for voice-mode replies.
 */

import { parseDeliveryCue, couldBeIncompleteCue } from '../src/voice/cue-parser.js';

interface ParseCase {
  in: string;
  desc: string | null;
  body: string;
}

const parseCases: ParseCase[] = [
  { in: '((deliver: gentle, slower)) Hello there.', desc: 'gentle, slower', body: 'Hello there.' },
  { in: '   ((deliver: warm and amused))\nYeah I get it.', desc: 'warm and amused', body: 'Yeah I get it.' },
  { in: '((deliver: )) Plain reply.', desc: null, body: 'Plain reply.' },
  { in: 'No cue here. ((deliver: too late))', desc: null, body: 'No cue here. ((deliver: too late))' },
  { in: 'Just a reply.', desc: null, body: 'Just a reply.' },
  { in: '((DELIVER: case insensitive)) text', desc: 'case insensitive', body: 'text' },
];

let failures = 0;
console.log('== parseDeliveryCue ==');
for (const tc of parseCases) {
  const got = parseDeliveryCue(tc.in);
  const ok = got.description === tc.desc && got.body === tc.body;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${JSON.stringify(tc.in)}`);
  if (!ok) {
    console.log(`  expected: desc=${JSON.stringify(tc.desc)} body=${JSON.stringify(tc.body)}`);
    console.log(`  got     : desc=${JSON.stringify(got.description)} body=${JSON.stringify(got.body)}`);
    failures++;
  }
}

console.log('\n== couldBeIncompleteCue ==');
const incCases: Array<{ in: string; expected: boolean }> = [
  { in: '((', expected: true },
  { in: '(', expected: true },
  { in: '((deliv', expected: true },
  { in: '((deliver: warm', expected: true },
  { in: '((deliver: warm)) Hello', expected: false },
  { in: 'Hello there', expected: false },
  { in: '(parenthetical aside)', expected: false },
  { in: '', expected: false },
];
for (const tc of incCases) {
  const got = couldBeIncompleteCue(tc.in);
  const ok = got === tc.expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${JSON.stringify(tc.in)} → ${got}`);
  if (!ok) failures++;
}

if (failures > 0) {
  console.log(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
process.exit(0);
