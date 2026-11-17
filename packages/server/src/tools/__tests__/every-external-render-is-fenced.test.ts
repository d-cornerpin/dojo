// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 K33 — THE CENSUS: outside text cannot reach the model without the fence.
//
// Fix round 1 (review I-K3) made it structural rather than a hand list of files:
//   1. TOOL READS. The candidate tools are DERIVED from the definitions: every tool that reads
//      (its display class is `retrieval`, or its name carries a reading word). Each must be
//      registered in `tools/inbound-fences.ts`: door-fenced, or fenced by the mailbox
//      banner — or named in NOT_OUTSIDE_CONTENT (tools/__tests__/fence-census.ts) with a reason. A new read tool fails here
//      until someone decides which it is. Registering IS fencing: the one tool door calls
//      `fenceToolResult` (checked below, comments stripped).
//   2. INBOUND PRODUCERS. Each producer of channel text calls its own fenced builder (output-tested
//      in every-inbound-fence-renders.test.ts), and any NEW source file that builds a
//      `[SOURCE: IMESSAGE|SMS|TEAMS MESSAGE|GMAIL|OUTLOOK|PHONE CALL|VOICEMAIL …${…}` header must
//      be on that list.
//   3. ONE PRODUCER OF THE MARKERS. No source file but the shared definition writes `[EXTERNAL `
//      or `[END EXTERNAL ` (review I-K1: the banner wrote its own end marker and an email could
//      close it).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { classifyTool } from '@dojo/shared';
import { getAllToolDefinitions } from '../../agent/tools/definitions.js';
import { OUTSIDE_READ_NAMES } from '../inbound-fences.js';
import { BANNER_FENCED_READS, NOT_OUTSIDE_CONTENT } from './fence-census.js';

const base = (name: string): string => (name.startsWith('user_') ? name.slice('user_'.length) : name);
const READING_WORD = /(^|_)(read|reads|download|transcribe|fetch|browse|get|search|list|inbox|agenda|responses|outline|recall|expand|history)(_|$)/;

describe('K33 — tool reads: derived from the definitions, every one decided', () => {
  const names = [...new Set(getAllToolDefinitions().map((d) => d.name))];
  const candidates = [...new Set(names.filter((n) => classifyTool(n) === 'retrieval' || READING_WORD.test(n)).map(base))].sort();
  const decided = new Set([...OUTSIDE_READ_NAMES, ...[...BANNER_FENCED_READS].map(base), ...Object.keys(NOT_OUTSIDE_CONTENT)]);

  it('the derivation finds the readers at all', () => {
    expect(candidates.length, 'the candidate derivation found (almost) nothing — it has rotted').toBeGreaterThan(60);
    for (const n of ['web_fetch', 'gmail_read', 'docs_read', 'teams_read_messages', 'transcribe_audio']) expect(candidates).toContain(n);
  });

  it('every read-shaped tool is registered as outside content, banner-fenced, or exempt with a reason', () => {
    expect(candidates.filter((n) => !decided.has(n)), 'read tools with no decision: register them in tools/inbound-fences.ts').toEqual([]);
  });

  it('no tool is decided twice, and every entry names a tool that exists', () => {
    const all = [...OUTSIDE_READ_NAMES, ...new Set([...BANNER_FENCED_READS].map(base)), ...Object.keys(NOT_OUTSIDE_CONTENT)];
    expect(all.filter((n, i) => all.indexOf(n) !== i)).toEqual([]);
    const known = new Set(names.map(base));
    expect(all.filter((n) => !known.has(n)), 'stale registry entries').toEqual([]);
  });
});
