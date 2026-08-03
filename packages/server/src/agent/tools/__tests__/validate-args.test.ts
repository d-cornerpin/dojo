// ════════════════════════════════════════════════════════════════════════════
// THE ONE SCHEMA-VALIDATION BOUNDARY (PHASE-5 T3 Step 3, RULING P5-R8)
//
// Before this, required-field validation lived in TWO hand-rolled mechanisms:
// 57 per-tool `checkRequired([...])` arrays at the top of `executeToolInner`'s
// dispatch cases (each re-typing field names and types the tool's own
// `input_schema` already declares), and 8 `validateAgainstSchema(...)` calls,
// one at the head of each provider dispatcher, which emitted a SECOND message
// family (`… is required for <toolName>.`).
//
// Both are now ONE compiled validator, driven by the tool's own
// `input_schema.required` + `properties[].type` plus the `fields` sibling that
// carries what no JSON-schema keyword can say. This file is the contract.
//
// WHY THE MESSAGES ARE ASSERTED BYTE-FOR-BYTE, not with `toContain`:
// the floor model READS these strings and retries on them, and behavioral
// scenarios key on them. One changed byte is a silent behavioural change across
// every tool at once, which is exactly the "refactor becomes an incident" class
// this phase exists to avoid. `toBe` on a literal is the only assertion that
// catches it.
//
// WHY `allowEmpty` AND `requiredNotEnforced` EXIST (and why the schema alone is
// NOT enough — this is the load-bearing finding of the conversion):
//   - `allowEmpty`: `file_write({path, content: ""})` writes an empty file and
//     always has. A validator compiled from the schema alone REFUSES it
//     ("`content` cannot be empty."), turning a working capability into an
//     error. No JSON-schema keyword expresses "required, but empty is fine".
//   - `requiredNotEnforced`: `input_schema.required` is ALSO model-facing
//     guidance, and for 11 fields it is stricter than what the runtime has ever
//     enforced. Compiling those would be a NEW refusal, i.e. less capability —
//     forbidden by this phase's posture and by RULING P5-R8. Each carries its
//     reason at the declaration site.
//
// SCOPE IS RULED (P5-R8) and is asserted below: this boundary owns exactly the
// tools whose hand-rolled validation it replaced. Tools that never had a
// required-field check do NOT gain one here — a new refusal is the owner's
// decision, never a refactor's side effect (the same rule RULING P5-R5 applied
// to ungated effects in T2).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { validateToolArgs, PER_TOOL_VALIDATED_AT_BOUNDARY } from '../validate-args.js';
import { checkRequired, type FieldSpec } from '../../tool-helpers.js';
import { getAllToolDefinitions, isBoundaryValidated } from '../definitions.js';
import type { ToolDefinition } from '../types.js';
import { checkEffectDeclarations } from '../effect-conformance.js';
import { classifyToolResult, toolResultOf, toolWasBlocked } from '../../tool-outcome.js';

const defsByName = new Map<string, ToolDefinition>(
  getAllToolDefinitions().map((d) => [d.name, d] as const),
);
const def = (name: string): ToolDefinition => {
  const d = defsByName.get(name);
  if (!d) throw new Error(`no such tool definition: ${name}`);
  return d;
};

describe('validateToolArgs — the four messages, byte for byte', () => {
  // A synthetic definition keeps these four assertions independent of any real
  // tool's schema, so a product schema change can never quietly rewrite the
  // contract the model retries on.
  const synthetic = {
    name: 'synthetic_probe',
    description: 'test fixture',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
        count: { type: 'number' },
        items: { type: 'array' },
      },
      required: ['path', 'count', 'items'],
    },
    effects: [],
  } as unknown as ToolDefinition;

  it('missing field → `x` is required.', () => {
    expect(validateToolArgs(synthetic, { count: 1, items: ['a'] }))
      .toBe('Error: `path` is required.');
  });

  it('null is missing too', () => {
    expect(validateToolArgs(synthetic, { path: null, count: 1, items: ['a'] }))
      .toBe('Error: `path` is required.');
  });

  it('wrong type → `x` must be a T (got A).', () => {
    expect(validateToolArgs(synthetic, { path: '/tmp/x', count: 'three', items: ['a'] }))
      .toBe('Error: `count` must be a number (got string).');
  });

  it('an array where a string is declared reports "array", not "object"', () => {
    expect(validateToolArgs(synthetic, { path: ['/tmp/x'], count: 1, items: ['a'] }))
      .toBe('Error: `path` must be a string (got array).');
  });

  it('empty string → `x` cannot be empty.', () => {
    expect(validateToolArgs(synthetic, { path: '   ', count: 1, items: ['a'] }))
      .toBe('Error: `path` cannot be empty.');
  });

  it('empty array → `x` cannot be empty (pass at least one item).', () => {
    expect(validateToolArgs(synthetic, { path: '/tmp/x', count: 1, items: [] }))
      .toBe('Error: `items` cannot be empty (pass at least one item).');
  });

  it('a fully valid call returns null', () => {
    expect(validateToolArgs(synthetic, { path: '/tmp/x', count: 1, items: ['a'] })).toBeNull();
  });

  it('reports the FIRST failure in schema order, like the sites it replaced', () => {
    expect(validateToolArgs(synthetic, {})).toBe('Error: `path` is required.');
  });

  it('no definition / empty required validates nothing', () => {
    expect(validateToolArgs(undefined, {})).toBeNull();
    const noReq = { ...synthetic, input_schema: { ...synthetic.input_schema, required: [] } } as ToolDefinition;
    expect(validateToolArgs(noReq, {})).toBeNull();
  });
});

describe('validateToolArgs is oracle-equivalent to the checkRequired sites it replaces', () => {
  // The deleted sites are reproduced here as their FieldSpec arrays, exactly as
  // they read at 1dbb202. If the compiled validator and the hand-rolled helper
  // ever disagree on any of these shapes, the conversion changed behaviour.
  const oracle: Array<{ tool: string; spec: (a: Record<string, unknown>) => FieldSpec[] }> = [
    { tool: 'file_read', spec: (a) => [{ name: 'path', value: a.path, type: 'string' }] },
    {
      tool: 'file_write',
      spec: (a) => [
        { name: 'path', value: a.path, type: 'string' },
        { name: 'content', value: a.content, type: 'string', allowEmpty: true },
      ],
    },
    {
      tool: 'assign_to_group',
      spec: (a) => [
        { name: 'agent_id', value: a.agent_id, type: 'string' },
        { name: 'group_id', value: a.group_id, type: 'string' },
      ],
    },
    {
      tool: 'mouse_click',
      spec: (a) => [
        { name: 'x', value: a.x, type: 'number' },
        { name: 'y', value: a.y, type: 'number' },
      ],
    },
    {
      tool: 'vault_update',
      spec: (a) => [
        { name: 'entry_id', value: a.entry_id, type: 'string' },
        { name: 'new_content', value: a.new_content, type: 'string' },
        { name: 'reason', value: a.reason, type: 'string' },
      ],
    },
  ];

  const shapes: Array<Record<string, unknown>> = [
    {},
    { path: '/tmp/a', content: 'hi', agent_id: 'a', group_id: 'g', x: 1, y: 2, entry_id: 'e', new_content: 'n', reason: 'r' },
    { path: '', content: '', agent_id: '', group_id: '', x: 1, y: 2, entry_id: '', new_content: '', reason: '' },
    { path: 5, content: 5, agent_id: 5, group_id: 5, x: '1', y: '2', entry_id: 5, new_content: 5, reason: 5 },
    { path: null, content: null, agent_id: null, group_id: null, x: null, y: null, entry_id: null, new_content: null, reason: null },
    { path: '  ', content: '  ', agent_id: '  ', group_id: '  ', x: 0, y: 0, entry_id: '  ', new_content: '  ', reason: '  ' },
  ];

  for (const { tool, spec } of oracle) {
    it(`${tool}: compiled validator === hand-rolled checkRequired on every shape`, () => {
      for (const args of shapes) {
        expect(validateToolArgs(def(tool), args), `${tool} with ${JSON.stringify(args)}`)
          .toBe(checkRequired(spec(args)));
      }
    });
  }
});

describe('allowEmpty — the capability a schema-only compile would have deleted', () => {
  it('file_write accepts an empty content (writing an empty file is real today)', () => {
    expect(validateToolArgs(def('file_write'), { path: '/tmp/x', content: '' })).toBeNull();
  });

  it('file_append accepts an empty content', () => {
    expect(validateToolArgs(def('file_append'), { path: '/tmp/x', content: '' })).toBeNull();
  });

  it('scratchpad_set accepts an empty content (that is how the pad is cleared)', () => {
    expect(validateToolArgs(def('scratchpad_set'), { content: '' })).toBeNull();
  });

  it('but a MISSING content is still required, and a non-string still type-errors', () => {
    expect(validateToolArgs(def('file_write'), { path: '/tmp/x' }))
      .toBe('Error: `content` is required.');
    expect(validateToolArgs(def('file_write'), { path: '/tmp/x', content: 7 }))
      .toBe('Error: `content` must be a string (got number).');
  });

  it('every allowEmpty declaration names a real property of its own schema', () => {
    for (const d of getAllToolDefinitions()) {
      for (const [field, decl] of Object.entries(d.fields ?? {})) {
        if (!decl?.allowEmpty) continue;
        expect(Object.keys(d.input_schema.properties), `${d.name}.${field}`).toContain(field);
      }
    }
  });
});

describe('requiredNotEnforced — the 11 fields where the schema is stricter than the runtime has ever been', () => {
  it('broadcast_to_group takes `payload` as an alias for `message` (schema says message is required)', () => {
    // The handler reads `args.payload ?? args.message`. A validator compiled
    // from `required` alone would REFUSE this working call.
    expect(validateToolArgs(def('broadcast_to_group'), { group_id: 'g', payload: 'hi', intent: 'FYI' }))
      .toBeNull();
  });

  it('send_to_agent takes `message` as an alias for `payload`', () => {
    expect(validateToolArgs(def('send_to_agent'), { agent: 'a', message: 'hi', intent: 'FYI' }))
      .toBeNull();
  });

  it('update_technique defaults change_summary rather than refusing without it', () => {
    expect(validateToolArgs(def('update_technique'), { name: 't' })).toBeNull();
  });

  it('web_fetch keeps its own prompt message (richer than the generic one)', () => {
    expect(validateToolArgs(def('web_fetch'), { url: 'https://x' })).toBeNull();
  });

  it('file_patch keeps its own patches-shape message', () => {
    expect(validateToolArgs(def('file_patch'), { path: '/tmp/x' })).toBeNull();
  });

  it('healer_propose keeps its own evidence gate', () => {
    expect(validateToolArgs(def('healer_propose'), {
      category: 'c', severity: 's', title: 't', description: 'd', proposed_fix: 'f', confidence: 1,
    })).toBeNull();
  });

  it('vault_remember keeps its own type enumeration message', () => {
    expect(validateToolArgs(def('vault_remember'), { content: 'c' })).toBeNull();
  });

  it('every requiredNotEnforced declaration names a real REQUIRED field and carries a reason', () => {
    for (const d of getAllToolDefinitions()) {
      for (const [field, decl] of Object.entries(d.fields ?? {})) {
        const reason = decl?.requiredNotEnforced;
        if (reason === undefined) continue;
        expect(Object.keys(d.input_schema.properties), `${d.name}.${field} is a property`).toContain(field);
        expect(d.input_schema.required, `${d.name}.${field} is required`).toContain(field);
        expect(String(reason).trim().length, `${d.name}.${field} has a reason`).toBeGreaterThan(0);
      }
    }
  });
});

describe('the declarations are policed — clause 7b bites', () => {
  // A declaration the boundary reads by FIELD NAME is only as good as the check
  // that the name is real: silently dropping `allowEmpty` turns
  // `file_write({content: ""})` from a working call into a refusal. These are the
  // planted faults, so the clause is proven to fire rather than assumed to.
  const base = {
    name: 'probe',
    description: 'x',
    effects: [],
    input_schema: {
      type: 'object' as const,
      properties: { content: { type: 'string' }, note: { type: 'string' } },
      required: ['content'],
    },
  };

  it('a fields key that is not a property of the schema fails', () => {
    const bad = { ...base, fields: { conten: { allowEmpty: true } } } as unknown as ToolDefinition;
    const problems = checkEffectDeclarations(bad);
    expect(problems.map((p) => p.clause)).toContain('7b field resolves');
  });

  it('requiredNotEnforced on a field that is not required fails', () => {
    const bad = { ...base, fields: { note: { requiredNotEnforced: 'because' } } } as unknown as ToolDefinition;
    const problems = checkEffectDeclarations(bad);
    expect(problems.map((p) => p.clause)).toContain('7b field resolves');
  });

  it('requiredNotEnforced with an empty reason fails — a ruling with no reason is silence', () => {
    const bad = { ...base, fields: { content: { requiredNotEnforced: '  ' } } } as unknown as ToolDefinition;
    const problems = checkEffectDeclarations(bad);
    expect(problems.map((p) => p.clause)).toContain('7b field resolves');
  });

  it('and a correct declaration passes', () => {
    const ok = { ...base, fields: { content: { allowEmpty: true } } } as unknown as ToolDefinition;
    expect(checkEffectDeclarations(ok).filter((p) => p.clause.startsWith('7b'))).toEqual([]);
  });
});

describe('the provider families fold into ONE message family', () => {
  it('a Slides tool missing a required field gets the plain message, not "… for <tool>."', () => {
    const slides = getAllToolDefinitions().find((d) => d.name === 'slides_create_presentation');
    expect(slides, 'slides_create_presentation exists').toBeTruthy();
    const first = slides!.input_schema.required[0];
    const msg = validateToolArgs(slides!, {});
    expect(msg).toBe(`Error: \`${first}\` is required.`);
    expect(msg).not.toContain(' for slides_create_presentation');
  });
});

describe('INVALID_ARGS reads REFUSED, not crashed', () => {
  // The boundary is this code's first writer. Before it, `INVALID_ARGS` sat in
  // `ToolErrorCode` with zero writers and a malformed call fell through to
  // `failed/crashed` — the platform reporting ITSELF broken for a call it had
  // understood perfectly well and declined.
  const rejected = {
    toolCallId: 't1',
    name: 'file_read',
    content: 'Error: `path` is required.',
    isError: true,
    errorCode: 'INVALID_ARGS' as const,
  };

  it('classifies as refused/invalid_args', () => {
    const outcome = classifyToolResult(rejected);
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toBe('invalid_args');
  });

  it('is NOT crashed — the platform did not break, it refused', () => {
    expect(classifyToolResult(rejected).kind).not.toBe('failed');
  });

  it('is NOT `blocked` either — retrying with corrected arguments is the right move', () => {
    // `toolWasBlocked` means "the door will keep saying no, retrying is a spin".
    // A malformed call is the opposite: the four messages exist precisely to tell
    // the model what to fix and call again.
    expect(toolWasBlocked(classifyToolResult(rejected))).toBe(false);
  });

  it('still hands the model the message — a refusal has content too', () => {
    expect(toolResultOf(classifyToolResult(rejected)).content).toBe('Error: `path` is required.');
  });
});

describe('SCOPE (RULING P5-R8): the boundary owns exactly what it replaced', () => {
  it('every per-tool name in the constant resolves to a real tool definition', () => {
    for (const name of PER_TOOL_VALIDATED_AT_BOUNDARY) {
      expect(defsByName.has(name), `${name} is a real tool`).toBe(true);
    }
  });

  it('the constant is exactly the 57 per-tool checkRequired sites the conversion deleted', () => {
    expect(new Set(PER_TOOL_VALIDATED_AT_BOUNDARY).size).toBe(57);
  });

  it('tools that never had a required-field check gain NO new refusal', () => {
    // Measured at 1dbb202: 37 definitions carry a non-empty `required` and had
    // neither a per-tool checkRequired site nor a validateAgainstSchema pass.
    // Enforcing them would be a new refusal, which RULING P5-R5 reserves to the
    // owner. They are OUT of this boundary, deliberately and by test.
    for (const name of ['exec', 'shell', 'spawn_agent', 'pdf_read', 'credential_get', 'image_create', 'show_to_user']) {
      expect(isBoundaryValidated(name), `${name} is out of scope`).toBe(false);
    }
  });

  it('the per-tool set and the provider families ARE in scope', () => {
    for (const name of ['file_read', 'vault_update', 'imessage_send']) {
      expect(isBoundaryValidated(name), `${name} is in scope`).toBe(true);
    }
    for (const name of ['slides_create_presentation', 'gmail_send', 'outlook_search']) {
      expect(isBoundaryValidated(name), `${name} (provider) is in scope`).toBe(true);
    }
  });

  it('the work verbs are NOT boundary-validated — their requiredness is per-operation', () => {
    // RULING P5-R8: `work_open:project` / `work_update:status` / … each carry
    // their own checkRequired for fields the verb-level schema union cannot
    // express. Those 19 sites STAY; folding them in would delete validation.
    for (const name of ['work_open', 'work_update', 'work_validate', 'work_schedule', 'work_close_request']) {
      expect(isBoundaryValidated(name), `${name} keeps its per-operation checks`).toBe(false);
    }
  });
});
