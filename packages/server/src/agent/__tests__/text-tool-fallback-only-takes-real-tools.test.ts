// 9604 — a JSON or tag example inside a plain answer is not a tool call. Fake data only.
import { describe, it, expect } from 'vitest';
import { extractTextToolCalls } from '../text-tool-fallback.js';

const FENCE = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```';
const TAG = '<tool_call><name>file_read</name><arguments>{"path":"/tmp/a"}</arguments></tool_call>';

describe('9604 — the text tool-call fallback takes only offered tools', () => {
  it('a package.json example in an answer is left alone', () => {
    const text = `Here is the file:\n${FENCE({ name: 'my-app', version: '1.0.0' })}`;
    const r = extractTextToolCalls(text, ['file_read']);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.cleanText).toBe(text);
  });
  it('an offered tag call is taken and its tag stripped', () => {
    const r = extractTextToolCalls(`Reading. ${TAG}`, ['file_read']);
    expect(r.toolCalls.map(c => c.name)).toEqual(['file_read']);
    expect(r.toolCalls[0].arguments).toEqual({ path: '/tmp/a' });
    expect(r.cleanText).toBe('Reading.');
  });
  it('with no tools offered nothing is taken and the text is unchanged', () => {
    const text = `Reading. ${TAG}`;
    expect(extractTextToolCalls(text, [])).toEqual({ toolCalls: [], cleanText: text });
  });
  it('only the accepted fenced block is removed, an unrelated one stays', () => {
    const example = FENCE({ name: 'my-app', version: '1.0.0' });
    const text = `Doing it.\n${FENCE({ name: 'file_read', arguments: { path: '/tmp/a' } })}\nFor reference:\n${example}`;
    const r = extractTextToolCalls(text, ['file_read']);
    expect(r.toolCalls.map(c => c.name)).toEqual(['file_read']);
    expect(r.cleanText).toContain(example);
    expect(r.cleanText).not.toContain('file_read');
  });
  it('an invoke call for a tool that was not offered is skipped', () => {
    const text = '<invoke name="shell"><parameter name="cmd">ls</parameter></invoke>';
    expect(extractTextToolCalls(text, ['file_read']).toolCalls).toHaveLength(0);
  });
});
