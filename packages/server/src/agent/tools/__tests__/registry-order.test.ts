// ════════════════════════════════════════════════════════════════════════════
// THE REGISTRY'S EMISSION ORDER IS A TEST, NOT A COMMENT (PHASE-5 T1, OR7)
//
// The cache-prefix rider (roadmap #10, research 25) names the hazard exactly: a
// Map filled across dynamically-imported modules iterates in insertion order, a
// nondeterministic tools array invalidates Anthropic's cache breakpoint — which
// sits on the LAST always-loaded tool — and makes the prefix golden fail
// intermittently. Breaking it fails no other test today; it just silently
// multiplies token cost, which is why this file exists.
//
// The strongest clause here is the third: the registry's emission is asserted
// BYTE-IDENTICAL to `getAllToolDefinitions()`'s, so the registry cannot reorder
// the wire — not at T1, and not at whatever later task cuts the executor over
// to it. A re-bless of the cache-prefix golden then has to be a deliberate act
// with its own ruling, never a side effect of the toolbox moving.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { getAllToolDefinitions } from '../../tools.js';
import {
  getToolRegistry,
  registryToolDefinitions,
  resetToolRegistry,
  effectsFor,
  declaredSecretFieldsByTool,
  effectCoverage,
} from '../registry.js';

describe('tool registry (PHASE-5 T1 Step 2)', () => {
  it('emits a DETERMINISTIC order across independent builds', () => {
    const first = registryToolDefinitions().map((d) => d.name);
    resetToolRegistry();
    const second = registryToolDefinitions().map((d) => d.name);
    expect(second).toEqual(first);
  });

  it('emits BYTE-IDENTICALLY to the declared source order — the registry cannot move the cached prefix', () => {
    const declared = getAllToolDefinitions().map((d) => d.name);
    const emitted = registryToolDefinitions().map((d) => d.name);
    expect(emitted).toEqual(declared);
    // And the payload projection itself, which is what the golden hashes.
    const project = (d: { name: string; description: string; input_schema: unknown }) =>
      ({ name: d.name, description: d.description, input_schema: d.input_schema });
    expect(JSON.stringify(registryToolDefinitions().map(project)))
      .toBe(JSON.stringify(getAllToolDefinitions().map(project)));
  });

  it('holds every tool exactly once — a duplicate name is ambiguous routing, not a merge', () => {
    const names = getAllToolDefinitions().map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    expect(getToolRegistry().size).toBe(names.length);
  });

  it('every entry carries the definition BY REFERENCE, so the registry cannot drift from the source', () => {
    const defs = getAllToolDefinitions();
    for (const def of defs) {
      const entry = getToolRegistry().get(def.name);
      expect(entry, `${def.name} is not in the registry`).toBeDefined();
      expect(entry!.def).toBe(def);
      expect(entry!.effects).toBe(def.effects);
    }
  });

  it('reports effect coverage from the REGISTRY, which is what T7 s exit gate consumes', () => {
    const cov = effectCoverage();
    expect(cov.total).toBe(437);
    expect(cov.declared).toBe(437);
    expect(cov.effectful).toBe(124);
    expect(cov.byKind.shell).toBe(1);
    expect(cov.byKind.applescript).toBe(1);
    expect(cov.byKind.spawn).toBe(1);
  });

  it('answers effects and declared secret fields by name, including through the user_ twins', () => {
    expect(effectsFor('exec')).toEqual([{ kind: 'shell', from: 'args.command' }]);
    expect(effectsFor('file_read')).toEqual([{ kind: 'fs_read', from: 'args.path' }]);
    expect(effectsFor('get_current_time')).toEqual([]);
    expect(effectsFor('not_a_tool')).toBeUndefined();
    // The twin inherits its base's declaration through the generation spread.
    expect(effectsFor('user_gmail_send')).toEqual(effectsFor('gmail_send'));

    const secrets = declaredSecretFieldsByTool();
    expect([...secrets.entries()].sort()).toEqual([
      ['credential_add', ['credentials']],
      ['credential_update', ['credentials']],
      ['technique_set_placeholder', ['value']],
    ]);
  });

  it('assigns a prompt-index category where one exists, and says null where none does', () => {
    expect(getToolRegistry().get('file_read')?.category).toBe('File & System');
    expect(getToolRegistry().get('credential_add')?.category)
      .toBe('Agent Credentials (encrypted API keys / tokens the agent uses to call services)');
    // A twin resolves through its base rather than reading as uncategorised.
    expect(getToolRegistry().get('user_gmail_send')?.category)
      .toBe(getToolRegistry().get('gmail_send')?.category);
  });
});
