// Every tool call a hint shows the model names a registered tool, its real parameters, and allowed values.
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT, model_id TEXT)");
db.exec("INSERT INTO agents (id, status) VALUES ('pm-1', 'idle'), ('trainer-1', 'idle'), ('healer-1', 'idle')");
vi.mock('../../../db/connection.js', () => ({ getDb: () => db, closeDb: vi.fn() }));
vi.mock('../../../config/platform.js', async () => ({
  ...(await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js')),
  isPrimaryAgent: (id: string) => id === 'primary', isPMAgent: (id: string) => id === 'pm-1',
  getPMAgentId: () => 'pm-1', getPMAgentName: () => 'Planner',
  getTrainerAgentId: () => 'trainer-1', getTrainerAgentName: () => 'Coach',
  getHealerAgentId: () => 'healer-1', getHealerAgentName: () => 'Mender',
}));
vi.mock('../../agent-task.js', async () => ({
  ...(await vi.importActual<typeof import('../../agent-task.js')>('../../agent-task.js')),
  resolveAgentTaskId: () => null,
  ownedOpenTasks: () => [{ id: 'task-0001-aaaa', title: 'Count the boxes' }, { id: 'task-0002-bbbb', title: 'Label the shelves' }],
}));
import { toolDefinitionsByName } from '../definitions.js';
import { gatesForCall } from '../gates.js';
import { evaluateGate } from '../gate-eval.js';
import { completeTaskHandIn } from '../cat/measure-door.js';
import { renderPmAwareness, renderTrainerAwareness, renderHealerAwareness } from '../../../prompt/assembler.js';

/** The calls a text shows, `name(key="value", ...)`, that the registered schemas do not accept. */
function unknownCalls(text: string): string[] {
  const tools = toolDefinitionsByName();
  const wrong: string[] = [];
  for (const [, name, inner] of text.matchAll(/\b([a-z][a-z0-9_]*)\(([^)]*)\)/g)) {
    const props = (tools.get(name)?.input_schema as { properties?: Record<string, { enum?: string[] }> } | undefined)?.properties;
    if (!props) { wrong.push(name); continue; }
    for (const [, key, value] of inner.matchAll(/(\w+)="([^"]*)"/g)) {
      if (!props[key] || (props[key].enum && !props[key].enum!.includes(value))) wrong.push(`${name}(${key}="${value}")`);
    }
  }
  return wrong;
}

describe('a hint names only calls that exist', () => {
  it('the PM-only refusal', async () => {
    const [gate] = gatesForCall('work_validate', { action: 'retask' }).filter((g) => g.kind === 'pm_only_operation');
    const out = await evaluateGate(gate, { agentId: 'helper-1', name: 'work_validate', args: { action: 'retask' }, resolveRef: () => null });
    const text = out.verdict.allowed ? '' : out.verdict.blockedMessage ?? '';
    expect(unknownCalls(text)).toEqual([]);
    expect(text).toContain('send_to_agent(');
  });

  it('the PM, Trainer and Healer sections of the system prompt', () => {
    const sections = [renderPmAwareness, renderTrainerAwareness, renderHealerAwareness].map((r) => r('primary') ?? '');
    for (const text of sections) {
      expect(unknownCalls(text)).toEqual([]);
      expect(text).toContain('send_to_agent(');
    }
  });

  it('the refusal of a helper ending itself while it owns open steps', async () => {
    const text = (await completeTaskHandIn('helper-1', 'complete', 'done')) ?? '';
    expect(text).toContain('Count the boxes');
    expect(unknownCalls(text)).toEqual([]);
    expect(text).toContain('complete_task(status="blocked")');
  });
});
