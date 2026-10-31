// sheets_append takes its row as one comma-separated string and the handler splits on
// every comma, so "Smith, John" silently lands in two cells and the description says
// nothing of it. sheets_write takes a 2D array, where a comma in a value stays in one
// cell; the description now points a comma-bearing value at that tool instead.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));
vi.mock('../accounts.js', () => ({ resolveGoogleAccountForTool: vi.fn(), resolveGoogleAccountForRead: vi.fn() }));

import { googleWriteToolDefinitions } from '../tools-write.js';

describe('sheets_append warns that a comma splits a value into two cells', () => {
  const def = googleWriteToolDefinitions.find((d) => d.name === 'sheets_append')!;
  const valuesDescription = String((def.input_schema.properties as Record<string, { description: string }>).values.description);

  it('names that a comma inside a value splits it into two cells', () => {
    expect(valuesDescription).toContain('A comma inside a value splits it');
  });

  it('points a comma-bearing value at sheets_write', () => {
    expect(valuesDescription).toContain('sheets_write');
  });
});
