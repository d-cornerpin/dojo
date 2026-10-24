// v3.5 PLAN BEFORE PROJECT, Task A2: a tool says what it can do in ONE call, on its own definition, and
// the facts are read back from the definitions, never from a list typed beside them.
import { describe, it, expect } from 'vitest';
import { getAllToolDefinitions } from '../../agent/tools/definitions.js';
import { scaleFactsFor, renderScaleFacts } from '../scale-facts.js';

const DEFS = getAllToolDefinitions();
const propsOf = (d: { input_schema: { properties: Record<string, unknown> } }) => d.input_schema.properties as Record<string, { type?: string }>;

describe('what the tools say they can do in one call', () => {
  it('the Gmail pair: label up to 1,000 messages a call, search 500 a page with a cursor', () => {
    const text = renderScaleFacts(scaleFactsFor(['gmail_label', 'gmail_search']));
    expect(text).toBe([
      'gmail_label: one call labels up to 1,000 messages (message_ids), or several conversations (thread_ids)',
      'gmail_search: one call returns up to 500 results (max_results); page_token continues the same query',
    ].join('\n'));
  });

  it('the owner\'s-mailbox twins say the same (they are the same tools on another mailbox)', () => {
    const text = renderScaleFacts(scaleFactsFor(['user_gmail_label', 'user_gmail_search']));
    expect(text).toContain('user_gmail_label: one call labels up to 1,000 messages');
    expect(text).toContain('user_gmail_search: one call returns up to 500 results');
  });

  it('a tool that declares nothing (the clock) contributes nothing, and a name that is no tool is skipped', () => {
    expect(scaleFactsFor(['get_current_time', 'no_such_tool'])).toEqual([]);
    expect(renderScaleFacts([])).toBe('');
  });

  it('each tool appears once and in the order asked', () => {
    expect(scaleFactsFor(['gmail_search', 'gmail_label', 'gmail_search']).map((f) => f.tool)).toEqual(['gmail_search', 'gmail_label']);
  });

  it('the directory listing says it lists every entry in one call', () => {
    expect(renderScaleFacts(scaleFactsFor(['file_list']))).toBe('file_list: one call lists every entry of a directory, with sizes');
  });
});

describe('the scale declarations are true of the schemas they sit on', () => {
  it('every declared batch / page argument is a real argument of that tool, of the right type', () => {
    const declared = DEFS.filter((d) => d.scale);
    expect(declared.length).toBeGreaterThanOrEqual(6);
    for (const d of declared) {
      const p = propsOf(d);
      if (d.scale!.batch) {
        expect(p[d.scale!.batch.arg]?.type, `${d.name}: batch.arg`).toBe('array');
        expect(d.scale!.batch.max, `${d.name}: batch.max`).toBeGreaterThan(1);
      }
      if (d.scale!.pages) {
        expect(p[d.scale!.pages.arg], `${d.name}: pages.arg`).toBeDefined();
        expect(p[d.scale!.pages.tokenArg]?.type, `${d.name}: pages.tokenArg`).toBe('string');
      }
      // A number in a note is said once, from the data beside it.
      expect(d.scale!.note.includes('{max}'), `${d.name}: {max} needs batch`).toBe(!!d.scale!.batch && d.scale!.note.includes('{max}'));
      if (d.scale!.note.includes('{max}')) expect(d.scale!.batch, `${d.name}`).toBeDefined();
      if (d.scale!.note.includes('{pageSize}')) expect(d.scale!.pages, `${d.name}`).toBeDefined();
      expect(renderScaleFacts([{ tool: d.name, scale: d.scale! }]), `${d.name}: unfilled placeholder`).not.toMatch(/\{(max|pageSize)\}/);
    }
  });

  // A tool whose schema takes a LIST OF IDS or a PAGE CURSOR is a tool whose one-call reach matters to a
  // plan, so it must say what that reach is. The few exemptions are lists that are not a batch of work.
  const EXEMPT: Record<string, string> = {
    'history_expand.summary_ids': 'expands stored summaries the agent is reading, not items it is working through',
    'vault_discard_archives.archive_ids': 'a curated clean-up of the agent\'s own archives, not a set of owner items',
    'lesson_record.evidence_event_ids': 'evidence references attached to one record, not a batch of work',
    'slides_reorder_slides.slide_ids': 'the new ORDER of a deck, not a batch of items to process',
  };
  it('every tool with an id-list argument or a page cursor declares scale, or is exempt with its reason', () => {
    const missing: string[] = [];
    const seenExempt = new Set<string>();
    for (const d of DEFS) {
      for (const [k, v] of Object.entries(propsOf(d))) {
        const idList = v?.type === 'array' && /_ids$/.test(k);
        const cursor = k === 'page_token';
        if (!idList && !cursor) continue;
        const key = `${d.name}.${k}`;
        if (EXEMPT[key]) { seenExempt.add(key); continue; }
        if (!d.scale) missing.push(key);
      }
    }
    expect(missing, 'declare `scale` on the tool, or add the argument to EXEMPT with a reason').toEqual([]);
    expect([...seenExempt].sort(), 'an exemption for an argument the tool no longer has is stale').toEqual(Object.keys(EXEMPT).sort());
  });
});
