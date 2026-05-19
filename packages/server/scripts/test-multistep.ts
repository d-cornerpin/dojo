#!/usr/bin/env tsx
/**
 * Heuristic-only test (no DB, no LLM). Locks in the v2.5.46 fix:
 *   - Short questions ("do you have any new emails today?") → single
 *   - Determiner before a noun-verb-ambiguous word ("any new emails") → noun
 *   - Genuine multi-step prompts still flag multi
 *   - Explicit project-creation requests still bypass auto-create
 */

import { multistepHeuristic, looksLikeQuestion, userExplicitlyAsksToCreateTracker } from '../src/agent/v2/classifiers/multistep.js';

interface Case {
  query: string;
  want: 'definitely_single' | 'definitely_multi' | 'ambiguous';
  note?: string;
}

const cases: Case[] = [
  // ── Regression: short lookup questions must NOT flag multi-step ──
  { query: 'Do you have any new emails from today?', want: 'definitely_single', note: 'v2.5.46 bug — "emails" was a false-positive verb' },
  { query: 'Any new messages from Kelly?',           want: 'definitely_single' },
  { query: 'What was the last text from Alex?',      want: 'definitely_single' },
  { query: 'Do you have any pending tasks?',         want: 'definitely_single' },
  { query: 'Is there a post about the launch?',      want: 'definitely_single' },
  { query: 'How many agents do we have in the roster currently?', want: 'definitely_single' },

  // ── Plain questions (no verb-noun ambiguity) ──
  { query: 'What time is it?',                       want: 'definitely_single' },
  { query: 'Who created the Demo project?',          want: 'definitely_single' },

  // ── Single-step commands (one action, no conjunction) ──
  { query: 'Open the dashboard',                                 want: 'definitely_single' },
  { query: 'Send an email to dcliff at gmail.com saying hello.', want: 'definitely_single', note: 'v2.5.46 — was fallback_multi' },
  { query: 'Schedule a meeting with John for Tuesday at 2pm.',   want: 'definitely_single' },
  { query: 'Delete the test files in /tmp',                      want: 'definitely_single' },
  { query: 'Generate a status report for the marketing team.',   want: 'definitely_single' },
  { query: 'Email me the latest numbers.',                       want: 'definitely_single' },

  // ── Genuine multi-step (must still flag multi) ──
  { query: 'Pull the sales stats and email me the report',                                                         want: 'definitely_multi' },
  { query: 'Go find x and respond. Then go find y and respond. Then go find z and respond.',                       want: 'definitely_multi' },
  { query: 'Download the logs, summarize them, and send a digest',                                                  want: 'definitely_multi' },
  { query: 'Search for matching files, then edit each one, then write a summary',                                   want: 'definitely_multi' },

  // ── Genuine multi-step phrased as a question (must still flag multi) ──
  { query: 'Can you find the latest report, summarize it, and email it to the team?',                              want: 'definitely_multi' },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const h = multistepHeuristic(c.query);
  const got = h.decision;
  const ok = got === c.want;
  if (ok) pass++; else fail++;
  const tag = ok ? 'PASS' : 'FAIL';
  const sig = `verbs=${h.signals.actionVerbs} conj=${h.signals.conjunctions} deliv=${h.signals.deliverables} q=${looksLikeQuestion(c.query)}`;
  console.log(`  ${tag}  [${got}] want=${c.want}  ${sig}  ${JSON.stringify(c.query)}`);
  if (!ok && c.note) console.log(`        note: ${c.note}`);
}

console.log(`\n${pass} pass, ${fail} fail (multistepHeuristic)\n`);

// Explicit-creation patterns still bypass auto-create
const explicit = [
  ['Start a project called "Demo" with two steps', true],
  ['Create a tracker task to follow up next week', true],
  ['Put this in the tracker for next Friday', true],
  ['Do you have any new emails from today?', false],
];
for (const [q, want] of explicit) {
  const got = userExplicitlyAsksToCreateTracker(q as string);
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  userExplicitlyAsksToCreateTracker(${JSON.stringify(q)}) = ${got}`);
}

console.log();
process.exit(fail > 0 ? 1 : 0);
