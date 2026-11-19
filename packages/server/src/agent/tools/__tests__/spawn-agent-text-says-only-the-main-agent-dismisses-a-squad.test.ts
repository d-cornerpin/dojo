import { describe, it, expect } from 'vitest';
import { getAllToolDefinitions } from '../definitions.js';

describe('spawn_agent text says only the main agent dismisses a squad', () => {
  it('the spawn_agent text says only the main agent dismisses a squad', () => {
    const d = getAllToolDefinitions().find((t) => t.name === 'spawn_agent')!;
    expect(d.description).toContain('Only the main agent can dismiss a squad, with delete_group.');
    expect(d.description).not.toContain('delete_group dismisses a squad you created');
  });
});
