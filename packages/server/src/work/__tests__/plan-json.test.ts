// v3.5 PLAN BEFORE PROJECT — planJson renders the stored plan, every prose field through the caller's scrub.
import { describe, it, expect } from 'vitest';
import { planJson } from '../plan-json.js';

const trim = (s: string): string => s.trim();
const upper = (s: string): string => s.toUpperCase();
const nothing = (s: string): string => '';
const same = (s: string): string => s;

describe('planJson', () => {
  it('scrubs every prose field', () => {
    expect(planJson({ approach: '  Ship it  ', steps: [{ title: '  Build  ', how: '  Compile  ', done: '  Green  ' }] }, trim)).toBe('{"approach":"Ship it","steps":[{"title":"Build","how":"Compile","done":"Green"}]}');
  });
  it('keeps the steps in order', () => {
    expect(planJson({ approach: 'Two', steps: [{ title: 'A', how: 'a1', done: 'ad' }, { title: 'B', how: 'b1', done: 'bd' }] }, trim)).toBe('{"approach":"Two","steps":[{"title":"A","how":"a1","done":"ad"},{"title":"B","how":"b1","done":"bd"}]}');
  });
  it('an empty step list', () => {
    expect(planJson({ approach: 'Solo', steps: [] }, trim)).toBe('{"approach":"Solo","steps":[]}');
  });
  it('an empty approach survives the scrub', () => {
    expect(planJson({ approach: '', steps: [{ title: 'A', how: 'B', done: 'C' }] }, trim)).toBe('{"approach":"","steps":[{"title":"A","how":"B","done":"C"}]}');
  });
  it('a measure stays verbatim after done', () => {
    expect(planJson({ approach: 'Count', steps: [{ title: 'C', how: 'search', done: 'zero', measure: { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'emails' } }] }, trim)).toBe('{"approach":"Count","steps":[{"title":"C","how":"search","done":"zero","measure":{"tool":"gmail_search","args":{"query":"in:inbox -label:Done"},"unit":"emails"}}]}');
  });
  it('an account measure survives a scrub that leaves prose alone', () => {
    expect(planJson({ approach: 'Acct', steps: [{ title: 'C', how: 'h', done: 'd', measure: { tool: 'user_gmail_search', args: { query: 'q', account: 'work' }, unit: 'items' } }] }, same)).toBe('{"approach":"Acct","steps":[{"title":"C","how":"h","done":"d","measure":{"tool":"user_gmail_search","args":{"query":"q","account":"work"},"unit":"items"}}]}');
  });
  it('every prose field goes through the scrub', () => {
    expect(planJson({ approach: 'shout', steps: [{ title: 'go', how: 'go', done: 'gone' }] }, upper)).toBe('{"approach":"SHOUT","steps":[{"title":"GO","how":"GO","done":"GONE"}]}');
  });
  it('a scrub that empties prose empties the plan too', () => {
    expect(planJson({ approach: 'x', steps: [{ title: 'a', how: 'b', done: 'c' }] }, nothing)).toBe('{"approach":"","steps":[{"title":"","how":"","done":""}]}');
  });
  it('an identity scrub leaves spaces untouched', () => {
    expect(planJson({ approach: ' keep ', steps: [{ title: ' keep ', how: ' h ', done: ' d ' }] }, same)).toBe('{"approach":" keep ","steps":[{"title":" keep ","how":" h ","done":" d "}]}');
  });
  it('JSON escapes newlines, quotes and tabs', () => {
    expect(planJson({ approach: 'line1\nline2', steps: [{ title: 'Say "go"', how: 'tab\there', done: 'ok' }] }, same)).toBe('{"approach":"line1\\nline2","steps":[{"title":"Say \\"go\\"","how":"tab\\there","done":"ok"}]}');
  });
  it('an em dash is not escaped', () => {
    expect(planJson({ approach: 'plain ascii', steps: [{ title: '— dash', how: 'plain', done: 'plain' }] }, same)).toBe('{"approach":"plain ascii","steps":[{"title":"— dash","how":"plain","done":"plain"}]}');
  });
  it('the plain typed shape', () => {
    expect(planJson({ approach: 'typed', steps: [{ title: 't', how: 'h', done: 'd' }] }, same)).toBe('{"approach":"typed","steps":[{"title":"t","how":"h","done":"d"}]}');
  });
});
