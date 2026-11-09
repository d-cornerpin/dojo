// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 K33 — THE CENSUS: outside text cannot reach the model without the fence.
//
// Fix round 1 (review I-K3) made it structural rather than a hand list of files:
//   1. TOOL READS. The candidate tools are DERIVED from the definitions: every tool that reads
//      (its display class is `retrieval`, or its name carries a reading word). Each must be
//      registered in `tools/inbound-fences.ts`: door-fenced, or fenced by the mailbox
//      banner — or named in its NOT_OUTSIDE_CONTENT with a reason. A new read tool fails here
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
import fs from 'node:fs';
import path from 'node:path';
import { classifyTool } from '@dojo/shared';
import { getAllToolDefinitions } from '../../agent/tools/definitions.js';
import { OUTSIDE_READ_NAMES, BANNER_FENCED_READS, NOT_OUTSIDE_CONTENT } from '../inbound-fences.js';

const SRC = path.resolve(__dirname, '../..');
const read = (abs: string): string => fs.readFileSync(abs, 'utf8');
/** Source with comments removed, so prose about a call cannot satisfy a clause. */
const code = (abs: string): string => read(abs).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

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

  it('the one tool door turns the marked span into the fence BEFORE admission and the platform\'s own lines', () => {
    const door = read(path.join(SRC, 'agent/tools/index.ts'));   // raw: a glob in a string can fool the comment stripper here
    const inner = door.slice(door.indexOf('async function executeToolInner('));
    const fence = inner.indexOf('content = fenceOutsideSpan(name, args, content, toolCall);');
    expect(fence, 'the door does not convert the marked span').toBeGreaterThan(0);
    expect(fence, 'the fence must come before admission (the kept whole is stored fenced)').toBeLessThan(inner.indexOf('admitToolResult(name, id, content, isError)'));
    expect(fence, 'and before the unknown-args warning is added').toBeLessThan(inner.indexOf('content = `${unknownArgsWarning}'));
  });
});

const PRODUCERS: ReadonlyArray<{ file: string; calls: RegExp; what: string }> = [
  { file: 'services/imessage-bridge.ts', calls: /inboundIMessageText\(/, what: 'an inbound iMessage' },
  { file: 'twilio/sms-inbound.ts', calls: /fenceExternal\('text message'/, what: 'an inbound SMS (buildContent)' },
  { file: 'twilio/call-session.ts', calls: /callUtteranceText\(otherPartyNumber/, what: 'the other party on a live call' },
  { file: 'services/teams-watcher.ts', calls: /teamsInboundContent\(/, what: 'an inbound Teams message' },
  { file: 'gateway/routes/twilio.ts', calls: /voicemailNoticeContent\(/, what: 'a voicemail' },
  { file: 'services/gmail-watcher.ts', calls: /mailNoticeContent\(/, what: 'the Gmail watcher notice' },
  { file: 'services/outlook-watcher.ts', calls: /mailNoticeContent\(/, what: 'the Outlook watcher notice' },
  { file: 'agent/a2a-transport.ts', calls: /a2aPayloadForModel\(target\.id/, what: 'an agent report to the main agent' },
  { file: 'vault/maintenance.ts', calls: /fenceExternal\('archive'/, what: 'each Dreamer archive' },
  { file: 'tools/inbound-fences.ts', calls: /fenceExternal\('chat message'[\s\S]*fenceExternal\('voicemail'[\s\S]*fenceExternal\('email'[\s\S]*fencedMailBlock\(/, what: 'the builders the Teams, voicemail and mail producers call' },
  // Fix round 4 (ruling 3): a contact's image or PDF (iMessage, MMS) is bracketed by its fence.
  { file: 'agent/runtime.ts', calls: /const fence = attachmentFenceOf\(dbMsg\.inbound_meta, dbMsg\.id\)/, what: 'a contact\'s received image or PDF (injectAttachmentBlocks)' },
];

describe('K33 — inbound producers', () => {
  it.each(PRODUCERS.map((p) => [p.file, p.what, p.calls] as const))('%s fences %s', (file, _what, calls) => {
    expect(code(path.join(SRC, file))).toMatch(calls);
  });

  // Fix round 4 (ruling 2): the dashboard badge reads the sender's display name from the stored
  // record, so the model-facing SOURCE line never needs to carry it outside the fence.
  it('the Teams watcher stamps the sender\'s display name in the message record', () => {
    expect(code(path.join(SRC, 'services/teams-watcher.ts'))).toMatch(/const inboundMetaObj = \{[^}]*\bsenderName,[^}]*\}/);
  });
});
