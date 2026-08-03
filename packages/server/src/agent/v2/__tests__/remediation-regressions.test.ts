// Regression tests for the 2026-06 remediation. These lock in the pure-logic
// guarantees of the fixes so the same bug class cannot silently return. Each
// describe block names the checklist item + matrix scenario it protects.

import { describe, it, expect } from 'vitest';
import { isNearDuplicateText } from '../classifiers/loop.js';
import { crossTurnFailureNote } from '../attempt-record.js';
import { isDestructiveCall } from '../../destructive-gate.js';
import { getAllToolDefinitions } from '../../tools/definitions.js';
import { buildTechniqueMatchQuery } from '../classifiers/technique.js';
import { pushEngineMessage } from '../engine-message.js';
import { detectContextGap } from '../classifiers/context-gap.js';

describe('4f — near-duplicate reply guard (catalog row 9)', () => {
  it('flags exact duplicates', () => {
    expect(isNearDuplicateText('All done with the report.', 'All done with the report.')).toBe(true);
  });

  it('flags an append-style repeat the old exact-match check missed', () => {
    // The conservative case the guard is FOR: the model re-emits its prior
    // reply with a trailing addition. Very high token overlap (~0.92 Jaccard).
    const a = 'I finished the quarterly report and emailed it to the finance team for their review this morning before the meeting.';
    const b = 'I finished the quarterly report and emailed it to the finance team for their review this morning before the meeting today.';
    expect(isNearDuplicateText(a, b)).toBe(true);
  });

  it('is conservative by design: moderate rewording is NOT blocked (it gates user replies, so it errs toward delivering)', () => {
    // ~0.67 Jaccard — a real reword, but below 0.9. Blocking a reply the user
    // might need is worse than letting a mild repeat through; full semantic
    // reply-dedup is the deferred hot-path change.
    const a = 'I finished the quarterly report and emailed it to the finance team this morning.';
    const b = 'I finished the quarterly report and emailed it to the finance team earlier today.';
    expect(isNearDuplicateText(a, b)).toBe(false);
  });

  it('does NOT flag substantively different replies', () => {
    const a = 'I finished the quarterly report and emailed it to the finance team.';
    const b = 'The flight to Denver is booked for Saturday at 9am, confirmation AB123.';
    expect(isNearDuplicateText(a, b)).toBe(false);
  });

  it('keeps short replies exact-only (a repeated "Done." is legitimate)', () => {
    expect(isNearDuplicateText('Done.', 'Done!')).toBe(false);
    expect(isNearDuplicateText('Done.', 'Done.')).toBe(true);
  });

  it('treats null/empty as not-duplicate', () => {
    expect(isNearDuplicateText(null, 'x')).toBe(false);
    expect(isNearDuplicateText(undefined, undefined)).toBe(false);
  });
});

describe('1a — tool-doc aggregate covers every family (S3.2/S3.3)', () => {
  // The original dead-ends happened because the doc generator used a hand-
  // maintained list that drifted. getAllToolDefinitions is now the single
  // source the generator consumes; this test fails the moment a family it
  // should cover falls out, so load_tool_docs can never silently dead-end
  // again. The four families below are the exact ones that were broken.
  const names = getAllToolDefinitions().map((t) => t.name);

  it('includes the forms family', () => {
    expect(names.some((n) => n.startsWith('forms_'))).toBe(true);
  });
  it('includes the pdf family', () => {
    expect(names.some((n) => n.startsWith('pdf_'))).toBe(true);
  });
  it('includes the credentials family', () => {
    expect(names.some((n) => n.startsWith('credential'))).toBe(true);
  });
  it('includes the plaud family', () => {
    expect(names.some((n) => n.toLowerCase().includes('plaud'))).toBe(true);
  });
  it('has no duplicate tool names (catches a family/name collision)', () => {
    // The doc generator dedups by name, so a duplicate is harmless to doc
    // generation, but it signals diverging definitions. slides_update_text's
    // double definition (two different schemas in google/tools-slides.ts) was
    // removed, so there are no known duplicates; this fails on ANY duplicate.
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });
});

describe('S5.1/S5.2 — attachment-aware technique match query', () => {
  it('keeps the user intent and the attachment filename, drops boilerplate', () => {
    const raw = 'post this to the family site\n[Image attached: vacation_beach.jpg (1259579 bytes), fileId: ad9a34d4-adb2]\nPath: /Users/x/.dojo/uploads/k/vacation_beach.jpg\nIf your model supports vision, this image is shown to you in this message; otherwise a text description or notice appears instead. Do not open image files with file_read.';
    const q = buildTechniqueMatchQuery(raw);
    expect(q).toContain('post this to the family site');
    expect(q).toContain('vacation_beach.jpg'); // filename survives as signal
    expect(q).toContain('image:'); // compact kind hint
    expect(q).not.toContain('fileId'); // hash noise gone
    expect(q).not.toContain('Path:'); // path noise gone
    expect(q).not.toContain('supports vision'); // capability boilerplate gone
  });

  it('passes plain text through unchanged (no attachments)', () => {
    expect(buildTechniqueMatchQuery('summarize the weekly report')).toBe('summarize the weekly report');
  });

  it('handles a photo-only message (just the pointer) into a usable hint', () => {
    const q = buildTechniqueMatchQuery('[Image attached: IMG_0421.HEIC (88231 bytes), fileId: zz]');
    expect(q).toContain('IMG_0421.HEIC');
    expect(q.toLowerCase()).toContain('image:');
    expect(q).not.toContain('fileId');
  });
});

describe('3c — one engine-message channel with dedup safety net', () => {
  it('pushes a fresh engine message', () => {
    const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    expect(pushEngineMessage(msgs, '[System note: x]')).toBe(true);
    expect(msgs).toHaveLength(1);
  });

  it('skips an identical engine message already in the recent tail', () => {
    const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: '[System note: x]' },
    ];
    expect(pushEngineMessage(msgs, '[System note: x]')).toBe(false);
    expect(msgs).toHaveLength(1); // not duplicated
  });

  it('allows a different engine message through', () => {
    const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: '[System note: x]' },
    ];
    expect(pushEngineMessage(msgs, '[Engine note: y]')).toBe(true);
    expect(msgs).toHaveLength(2);
  });
});

describe('ask-when-stuck — engine context-gap detection (replaces #5)', () => {
  it('nudges to ask when an attachment arrives with no instruction', () => {
    const hint = detectContextGap('[Image attached: IMG_0421.HEIC (88231 bytes), fileId: zz]\nPath: /x');
    expect(hint).not.toBeNull();
    expect(hint!.toLowerCase()).toContain('ask');
  });

  it('nudges on a bare attachment with only filler text', () => {
    expect(detectContextGap('here\n[Image attached: pic.jpg (10 bytes), fileId: q]')).not.toBeNull();
  });

  it('does NOT nudge when the user gave a real instruction with the attachment', () => {
    expect(detectContextGap('post this to the family website please\n[Image attached: vacation.jpg (10 bytes), fileId: q]')).toBeNull();
  });

  it('does NOT nudge on a plain text message with no attachment', () => {
    expect(detectContextGap('what is the capital of France?')).toBeNull();
    expect(detectContextGap('')).toBeNull();
    expect(detectContextGap(null)).toBeNull();
  });
});

describe('2f — cross-turn repeated-failure note (S6.2)', () => {
  it('stays silent below the threshold', () => {
    expect(crossTurnFailureNote('file_read', 1)).toBeNull();
    expect(crossTurnFailureNote('file_read', 2)).toBeNull();
  });

  it('warns at and above the third identical cross-turn failure', () => {
    const note = crossTurnFailureNote('file_read', 3);
    expect(note).not.toBeNull();
    expect(note).toContain('file_read');
    expect(note).toContain('3 times');
    expect(crossTurnFailureNote('file_read', 7)).toContain('7 times');
  });
});

describe('4d — destructive-action detection (open question 6 gate)', () => {
  it('flags file_delete', () => {
    expect(isDestructiveCall('file_delete', { path: '/tmp/x' })).toBe('file deletion');
  });

  it('flags destructive shell commands', () => {
    expect(isDestructiveCall('exec', { command: 'rm /tmp/x' })).toBe('destructive shell command');
    expect(isDestructiveCall('exec', { command: 'git push --force origin main' })).toBe('destructive shell command');
    expect(isDestructiveCall('exec', { command: 'git reset --hard HEAD~3' })).toBe('destructive shell command');
  });

  it('does NOT flag ordinary tool calls', () => {
    expect(isDestructiveCall('file_read', { path: '/tmp/x' })).toBeNull();
    expect(isDestructiveCall('exec', { command: 'ls -la /tmp' })).toBeNull();
    expect(isDestructiveCall('gmail_send', { to: 'a@example.com' })).toBeNull();
  });

  it('does not false-positive on benign substrings (e.g. "form" containing no rm word-boundary)', () => {
    expect(isDestructiveCall('exec', { command: 'echo performance' })).toBeNull();
    expect(isDestructiveCall('exec', { command: 'npm run format' })).toBeNull();
  });
});
