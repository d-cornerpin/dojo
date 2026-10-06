// ════════════════════════════════════════════════════════════════════════════════════════
// THE ASSEMBLED ISSUE BODY FITS GITHUB — OWNER RULING 2026-10-05 #13.
//
// The ruling, verbatim from the decisions batch: *"one bound = GitHub's 65,536-char issue body,
// no per-field caps"*. So this file composes the WORST CASE the platform can assemble and
// asserts the one number, with the literal written here rather than imported — a clause that
// reads the constant it is checking cannot catch the constant being moved.
//
// ── WHAT THE WORST CASE IS, AND WHY IT IS NOT HYPOTHETICAL ──
// `window.ts`'s COLLECTOR_CAPS were the only size discipline the PUBLISHED attachment had, and
// that file says in its own header that a row cap is not a size bound. Seeded to every cap
// exactly — 20 turns, 60 calls, 200 tool calls, 25 work rows, each tool call carrying 24
// `arg_shape` entries — the attachment renders 601,404 characters on its own: 9.2x the limit,
// before a word of the brief. The first clause below measures that, so nobody has to take the
// number on trust, and the rest assert what the bound now does about it.
//
// ── AND THE BRIEF IS NEVER THE THING THAT GIVES WAY ──
// It is the text the owner read and approved. The attachment is machine-built and its whole
// copy stays on the box. A clause for each direction.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { GITHUB_ISSUE_BODY_MAX_CHARS, renderIssueBody, issueLabelsFor } from '../issue-body.js';
import { buildTelemetry } from '../telemetry-build.js';
import { COLLECTOR_CAPS } from '../window.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ReportRow, ReportBrief } from '../store.js';

const SERVER_SRC = path.resolve(__dirname, '../..');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** GitHub's documented ceiling, written out. The product's constant is compared against it. */
const GITHUB_LIMIT = 65_536;

/**
 * The declared per-field ceilings on the only door that has any — `EditReportSchema` in
 * `gateway/routes/reports.ts`.
 *
 * READ OFF THAT DOOR, never retyped here, so the worst case below is composed from the caps
 * the product actually enforces: raise one of them and this clause re-measures against the new
 * number instead of quietly testing an old one. Comments are stripped first, and the clause
 * refuses rather than guessing if the shape it reads is not there any more.
 */
function editDoorCaps(): { title: number; field: number } {
  const src = stripComments(fs.readFileSync(path.join(SERVER_SRC, 'gateway/routes/reports.ts'), 'utf-8'));
  const title = src.match(/title:\s*z\.string\(\)\.min\(1\)\.max\((\d+)\)/);
  const fields = [...src.matchAll(/(?:whatHappened|whatShouldHaveHappened|whyItWentWrong|fixIdeas):\s*z\.string\(\)\.min\(1\)\.max\((\d+)\)/g)];
  if (!title || fields.length !== 4) {
    throw new Error('EditReportSchema no longer declares a title cap and four field caps — the worst case cannot be composed');
  }
  const sizes = new Set(fields.map(m => Number(m[1])));
  if (sizes.size !== 1) throw new Error(`the four brief fields no longer share one cap: ${[...sizes].join(', ')}`);
  return { title: Number(title[1]), field: [...sizes][0] };
}

/** Every collector at its cap, every row as fat as its shape allows. */
function maximalTelemetry(): Record<string, unknown> {
  const argShape = Array.from({ length: 24 }, (_, i) => ({ key: `argument_key_${i}`, type: 'string', bytes: 999_999 }));
  return buildTelemetry({
    reportId: 'r', createdAt: '2026-10-05 00:00:00', signature: 'f'.repeat(64), lane: 'tool-loop',
    platformVersion: '3.2.2', osPlatform: 'darwin', nodeMajor: 22,
    windowMinutes: 1_440, windowTurns: COLLECTOR_CAPS.turns, windowTruncated: true,
    turns: Array.from({ length: COLLECTOR_CAPS.turns }, () => ({
      kind: 'user_message', subjectKind: 'owner', lane: 'owner', exitReason: 'answered',
      answered: true, effectfulCalls: 99, durationMs: 999_999,
    })),
    calls: Array.from({ length: COLLECTOR_CAPS.calls }, () => ({
      providerKind: 'anthropic', modelOrdinal: 9, requestType: 'agent_turn',
      inputTokens: 999_999, outputTokens: 999_999, cacheReadTokens: 999_999,
      cacheCreationTokens: 999_999, latencyMs: 999_999, inputTokensEstimated: true,
    })),
    toolCalls: Array.from({ length: COLLECTOR_CAPS.toolCalls }, () => ({
      name: 'file_write', actionType: 'write', result: 'ok',
      argShape, argsTotalBytes: 999_999, failureHitCount: 99,
    })),
    work: Array.from({ length: COLLECTOR_CAPS.work }, () => ({
      kind: 'commitment', state: 'waiting_human', ageMinutes: 999_999,
    })),
    settings: {
      providerKind: 'anthropic', behavesLike: 'claude', firstChunkTimeoutMs: 999_999,
      streamIdleTimeoutMs: 999_999, maxUnattendedMinutes: 999_999, prefillTokensPerSec: 999_999,
      toolsGrantedCount: 999, contextReceiptMode: 'full',
    },
  }) as Record<string, unknown>;
}

function brief(fieldChars: number, titleChars: number): ReportBrief {
  const fill = (n: number): string => 'x'.repeat(n);
  return {
    title: fill(titleChars),
    whatHappened: fill(fieldChars),
    whatShouldHaveHappened: fill(fieldChars),
    whyItWentWrong: fill(fieldChars),
    fixIdeas: fill(fieldChars),
  };
}

function row(b: ReportBrief, telemetry: Record<string, unknown>): ReportRow {
  return {
    id: '0f6f237c-0000-4000-8000-000000000001',
    lane: 'tool-loop',
    signature: 'f'.repeat(64),
    brief: b,
    telemetry,
  } as unknown as ReportRow;
}

describe('ruling #13 — one bound, and it is GitHub\'s issue body', () => {
  it('the product constant IS GitHub\'s number', () => {
    expect(GITHUB_ISSUE_BODY_MAX_CHARS).toBe(GITHUB_LIMIT);
  });

  it('⚠ THE MEASUREMENT: the unbounded attachment alone is many times the limit', () => {
    const chars = JSON.stringify(maximalTelemetry(), null, 2).length;
    expect(chars).toBeGreaterThan(GITHUB_LIMIT * 5);
  });

  it('⚠ THE WORST CASE — every section at its cap, the brief at the declared field caps — fits 65,536', () => {
    const caps = editDoorCaps();
    const body = renderIssueBody(row(brief(caps.field, caps.title), maximalTelemetry()));
    expect(body.length).toBeLessThanOrEqual(GITHUB_LIMIT);
    // And the labels, which ride the same create call. GitHub caps a label name at 50.
    for (const label of issueLabelsFor('3.2.2')) expect(label.length).toBeLessThanOrEqual(50);
  });

  it('⚠ THE BRIEF IS NEVER WHAT GIVES WAY — every word of it survives the bound', () => {
    const caps = editDoorCaps();
    const b = brief(caps.field, caps.title);
    const body = renderIssueBody(row(b, maximalTelemetry()));
    for (const key of ['whatHappened', 'whatShouldHaveHappened', 'whyItWentWrong', 'fixIdeas'] as const) {
      expect(body, `${key} is verbatim`).toContain(b[key]);
    }
  });

  it('⚠ the trim is SAID OUT LOUD, and it says where the whole attachment is', () => {
    const body = renderIssueBody(row(brief(8_000, 120), maximalTelemetry()));
    // One of the two honest forms: the per-section notes, or the last-resort size record.
    expect(/publishedBounds|"omitted": true/.test(body)).toBe(true);
    expect(body).toContain('size budget');
  });

  it('a small report is UNTOUCHED — the bound does not trim what fits', () => {
    const small = { report: { lane: 'tool-loop' }, turns: [{ ordinal: 0 }] };
    const body = renderIssueBody(row(brief(50, 20), small));
    expect(body).toContain(JSON.stringify(small, null, 2));
    expect(body).not.toContain('publishedBounds');
  });

  it('⚠ the footer and the trailers are inside the bound, not appended after it', () => {
    const body = renderIssueBody(row(brief(8_000, 120), maximalTelemetry()));
    expect(body).toContain('dojo-sig: ');
    expect(body).toContain('dojo-report-id: ');
    expect(body).toContain('dojo-version: ');
    expect(body.length).toBeLessThanOrEqual(GITHUB_LIMIT);
  });

  it('⚠ THE WIRE: `report/post.ts` refuses before it reaches `createIssue`', () => {
    const src = stripComments(fs.readFileSync(path.join(SERVER_SRC, 'report/post.ts'), 'utf-8'));
    const guard = src.indexOf('body.length > GITHUB_ISSUE_BODY_MAX_CHARS');
    const create = src.indexOf('createIssue(');
    expect(guard, 'post.ts compares the assembled body against the bound').toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    // POSITION, not presence: a check after the call would be a refusal GitHub answered first.
    expect(guard).toBeLessThan(create);
    // And the sentence names the number, so the owner is not handed an opaque 422.
    expect(src).toMatch(/\$\{GITHUB_ISSUE_BODY_MAX_CHARS\}-character limit/);
  });

  it('⚠ a brief longer than the WHOLE limit is the one case the renderer cannot fix', () => {
    // Reachable from the tool door, which caps no field — which is why `report/post.ts` refuses
    // before the network instead of letting GitHub answer 422. The renderer's job is to not
    // trim the owner's words, and it does not.
    const huge = brief(20_000, 120);
    const body = renderIssueBody(row(huge, maximalTelemetry()));
    expect(body.length).toBeGreaterThan(GITHUB_LIMIT);
    expect(body).toContain(huge.whatHappened);
  });
});
