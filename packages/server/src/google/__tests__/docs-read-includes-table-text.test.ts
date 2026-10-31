// docs_read used to drop every table in a document; table text must come through.
import { describe, it, expect, vi } from 'vitest';

let content: unknown[] = [];
const googleRead = vi.fn(async () => ({ ok: true as const, data: { title: 'Doc', body: { content } } }));
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => (googleRead as (...x: unknown[]) => unknown)(...a) }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: (kind: string) => ({ account: { id: `acct-${kind}`, email: 'a@example.invalid' }, labelAccount: false }),
}));

const { executeGoogleReadTool } = await import('../tools-read.js');

const para = (t: string) => ({ paragraph: { elements: [{ textRun: { content: t } }] } });
const cell = (t: string) => ({ content: [para(t)] });

describe('docs_read includes table text', () => {
  it('puts the table cells between the surrounding paragraphs', async () => {
    content = [para('Intro\n'), { table: { tableRows: [
      { tableCells: [cell('A\n'), cell('B\n')] },
      { tableCells: [cell('C\n'), cell('D\n')] },
    ] } }, para('Outro\n')];
    const out = await executeGoogleReadTool('docs_read', { document_id: 'd1' }, 'agent-1', 'Agent');
    expect(out).toContain('Intro\nA\tB\nC\tD\nOutro');
  });

  it('a document with only paragraphs reads as before', async () => {
    content = [para('One\n'), para('Two\n')];
    const out = await executeGoogleReadTool('docs_read', { document_id: 'd1' }, 'agent-1', 'Agent');
    expect(out).toContain('One\nTwo\n');
  });
});
