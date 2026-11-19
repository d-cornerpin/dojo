// The exec/shell descriptions told the model a command is stopped after 30 seconds of silence.
// The real rule (process-run.ts, processTimeout) is the agent's silent window, two hours by default.
import { describe, it, expect } from 'vitest';
import { getAllToolDefinitions } from '../definitions.js';

describe('exec and shell texts state no 30-second timeout', () => {
  it('exec does not claim a 30-second idle timeout', () => {
    const d = getAllToolDefinitions().find((t) => t.name === 'exec')!;
    expect(d.description).not.toContain('30-second');
    expect(d.description).not.toContain('for 30s');
    expect(d.description).toContain('Use the `shell` tool when you need any of those.');
  });

  it('shell does not claim a 30-second idle timeout', () => {
    const d = getAllToolDefinitions().find((t) => t.name === 'shell')!;
    expect(d.description).not.toContain('30-second');
    expect(d.description).not.toContain('for 30s');
    expect(d.description).toContain('The whole script text is recorded.');
  });

  it('the timeout argument still states the silent window', () => {
    for (const name of ['exec', 'shell']) {
      const d = getAllToolDefinitions().find((t) => t.name === name)!;
      const props = d.input_schema.properties as Record<string, { description: string }>;
      expect(props.timeout.description).toContain('silent window');
    }
  });
});
