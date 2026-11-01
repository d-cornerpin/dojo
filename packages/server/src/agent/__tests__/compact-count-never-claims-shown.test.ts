// A list tool states how many results it holds and the form they are in. Whether the agent can SEE them all is the
// view layer's truth (memory/tool-result-view.ts excerpts a long result and labels the gap), so a tool header must
// never say "N shown": on a long list the two statements contradicted each other.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compactCountNote, compactListTrailer } from '../tool-helpers.js';
import { toolResultView, TOOL_RESULT_VIEW_CHARS } from '../../memory/tool-result-view.js';

const SHOWN_CLAIM = /\b(results?|rows?|items?)\s+shown\b|\}\s+shown\b|\bshown\s*\(compact\)/i;

describe('compact list counts', () => {
  it('state a count and a form, never that the results are shown', () => {
    expect(compactCountNote(25)).toBe('25 results in compact form');
    expect(compactCountNote(1)).toBe('1 result in compact form');
    expect(compactCountNote(3, 'task/project row')).toBe('3 task/project rows in compact form');
    const trailer = compactListTrailer({ count: 25, expandTool: 'x_get', expandArg: 'id', listTool: 'x_list', verbose: false });
    expect(trailer).not.toMatch(SHOWN_CLAIM);
    expect(trailer).toContain('25 results in compact form');
  });

  it('a long compact list reaches the model as an excerpt whose label is the only visibility claim', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `[${i}] sender ${i} | subject ${i} | ${'snippet '.repeat(400)}`);
    const whole = `Found 25 email(s):\n\n${lines.join('\n')}\n\n${compactCountNote(25)}. For full body of one: gmail_read(message_id=<id>).`;
    expect(whole.length).toBeGreaterThan(TOOL_RESULT_VIEW_CHARS / 8);
    const view = toolResultView(whole, 'call-1', TOOL_RESULT_VIEW_CHARS / 8 + 1500);
    expect(view).toContain('NOT ALL SHOWN');
    expect(view).not.toMatch(SHOWN_CLAIM);
  });

  it('no list tool words its own "N shown" claim', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    for (const f of ['google/gmail-search.ts', 'google/tools-read.ts', 'microsoft/tools-read.ts', 'tracker/tools.ts', 'techniques/tools.ts', 'agent/tool-helpers.ts']) {
      const src = readFileSync(`${root}/${f}`, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
      expect(src.filter((l) => SHOWN_CLAIM.test(l)), f).toEqual([]);
    }
  });
});
