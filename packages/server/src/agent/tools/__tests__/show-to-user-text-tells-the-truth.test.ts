// The `show_to_user` text the model reads must say what the handler actually does:
// the files join the agent's next reply, documents are refused, and the caption is
// the reply only when the turn ends without one. Reads the definitions, never source text.

import { describe, it, expect } from 'vitest';
import { getAllToolDefinitions } from '../definitions.js';

const d = () => getAllToolDefinitions().find((t) => t.name === 'show_to_user')!;
const prop = (k: string) => (d().input_schema.properties as Record<string, { description: string }>)[k].description;

describe('show_to_user text tells the truth', () => {
  it('the text says the files join the next reply', () => {
    expect(d().description).not.toContain('inserts an assistant-role message');
    expect(d().description).not.toContain('end your turn');
    expect(d().description).toContain('attaches the files to your next reply');
  });

  it('the file list text does not promise PDFs', () => {
    expect(prop('file_paths')).not.toContain('PDFs render');
    expect(prop('file_paths')).toContain('a PDF or other document is refused');
  });

  it('the caption text says when it is used', () => {
    expect(prop('caption')).toContain('only if you end the turn without writing reply text');
  });
});
