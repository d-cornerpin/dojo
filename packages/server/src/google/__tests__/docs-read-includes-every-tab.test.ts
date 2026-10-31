// docs_read read only the FIRST tab of a Google Doc: `documents.get` without
// includeTabsContent=true fills just the legacy `body` and leaves `tabs` empty.
// Every tab's text (and every nested child tab's) must come through, named.
import { describe, it, expect, vi } from 'vitest';
import { outsideSpan } from '../../tools/external-content.js';

let data: Record<string, unknown> = {};
let lastUrl = '';
const googleRead = vi.fn(async (url: unknown) => {
  lastUrl = String(url);
  return { ok: true as const, data };
});
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => (googleRead as (...x: unknown[]) => unknown)(...a) }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: (kind: string) => ({ account: { id: `acct-${kind}`, email: 'a@example.invalid' }, labelAccount: false }),
}));

const { executeGoogleReadTool } = await import('../tools-read.js');

const para = (t: string) => ({ paragraph: { elements: [{ textRun: { content: t } }] } });
const tab = (title: string, text: string, childTabs?: unknown[]) => ({
  tabProperties: { title },
  documentTab: { body: { content: [para(text)] } },
  ...(childTabs ? { childTabs } : {}),
});

describe('docs_read includes every tab of a document', () => {
  it('two top-level tabs both come through, each under its own header', async () => {
    // The real API fills the legacy `body` with only the first tab's content.
    data = {
      title: 'Doc',
      body: { content: [para('plan text\n')] },
      tabs: [tab('Plan', 'plan text\n'), tab('Notes', 'notes text\n')],
    };
    const out = await executeGoogleReadTool('docs_read', { document_id: 'd1' }, 'agent-1', 'Agent');
    expect(out).toContain('=== Tab: Plan ===\nplan text\n');
    expect(out).toContain('=== Tab: Notes ===\nnotes text\n');
    expect(out.indexOf('=== Tab: Plan ===')).toBeLessThan(out.indexOf('=== Tab: Notes ==='));
  });

  it('a child tab comes right after its parent', async () => {
    data = {
      title: 'Doc',
      body: { content: [para('parent text\n')] },
      tabs: [tab('Parent', 'parent text\n', [tab('Child', 'child text\n')])],
    };
    const out = await executeGoogleReadTool('docs_read', { document_id: 'd1' }, 'agent-1', 'Agent');
    expect(out).toContain('=== Tab: Parent ===\nparent text\n=== Tab: Child ===\nchild text\n');
  });

  it('one tab only: no header, output exactly as the old body-based read', async () => {
    data = {
      title: 'Doc',
      body: { content: [para('only tab text\n')] },
      tabs: [tab('Only', 'only tab text\n')],
    };
    const out = await executeGoogleReadTool('docs_read', { document_id: 'd1' }, 'agent-1', 'Agent');
    expect(out).not.toContain('=== Tab:');
    expect(out).toBe(`Document: ${outsideSpan('Doc')}\n\n${outsideSpan('only tab text\n')}`);
  });

  it('no tabs field: the legacy body still reads as before', async () => {
    data = { title: 'Doc', body: { content: [para('body text\n')] } };
    const out = await executeGoogleReadTool('docs_read', { document_id: 'd1' }, 'agent-1', 'Agent');
    expect(out).not.toContain('=== Tab:');
    expect(out).toBe(`Document: ${outsideSpan('Doc')}\n\n${outsideSpan('body text\n')}`);
  });

  it('asks the Docs API for the tab contents', async () => {
    data = { title: 'Doc', body: { content: [] } };
    await executeGoogleReadTool('docs_read', { document_id: 'd1' }, 'agent-1', 'Agent');
    expect(lastUrl).toContain('includeTabsContent=true');
  });
});
