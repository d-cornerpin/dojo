// THE EFFECTS-DECLARATION WALK, read by the conformance tests (a test-support module, not product).
// The declaration is the source of truth; this scan is the tripwire the other way: silence fails.
// A field scan alone misses fixed-host and no-argument effects (web_search) and nested fields
// (repos[].url), so the declaration is the truth.

import {
  EFFECT_FROM_ARGS,
  EFFECT_FROM_DERIVED,
  EFFECT_FROM_FIXED,
  EFFECT_KINDS,
  type ToolDefinition,
} from '../types.js';
import { declaredSecretFields } from '../registry.js';

/**
 * FIELD NAMES THAT LOOK LIKE A RESOURCE (paths, urls, commands, at any depth). Deliberately
 * generous: a false positive costs one `nonEffects` line, a false negative an undeclared effect.
 */
export const EFFECTFUL_FIELD_NAMES: ReadonlySet<string> = new Set([
  'path', 'file_path', 'paths', 'url', 'command', 'script',
  'file_paths', 'attach_paths', 'input_paths', 'save_path', 'source_path',
  'image_path', 'install_to', 'install_in', 'destination', 'file', 'files',
  'output_filename', 'filename', 'entry_filename', 'attachments',
  'image_url', 'background_image_url', 'link_url', 'video_url', 'source_url',
]);

export interface SchemaField {
  /** Dotted path with `[]` for array elements: `dependencies.repos[].url`. */
  path: string;
  type: string;
}

/**
 * Every schema property, recursively, through `properties` and array `items`. Arrays yield the
 * ELEMENT as `<path>[]`: brokers resolve elements, and untyped items with `properties` recurse.
 */
export function walkSchemaFields(def: Pick<ToolDefinition, 'input_schema'>): SchemaField[] {
  const out: SchemaField[] = [];
  const seen = new Set<unknown>();

  const recurse = (node: unknown, prefix: string): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const props = (node as { properties?: unknown }).properties;
    if (!props || typeof props !== 'object') return;
    for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
      const child = raw as { type?: unknown; items?: unknown; properties?: unknown } | undefined;
      const path = prefix ? `${prefix}.${key}` : key;
      out.push({ path, type: typeof child?.type === 'string' ? child.type : '?' });
      if (child?.properties) recurse(child, path);
      if (child?.items) {
        const item = child.items as { type?: unknown } | undefined;
        out.push({ path: `${path}[]`, type: typeof item?.type === 'string' ? item.type : '?' });
        recurse(child.items, `${path}[]`);
      }
    }
  };

  recurse(def.input_schema, '');
  return out;
}

export function leafFieldName(path: string): string {
  const last = path.split('.').pop() ?? path;
  return last.replace(/\[\]$/, '');
}

export interface ConformanceProblem {
  tool: string;
  clause: string;
  detail: string;
}

// THE ADVERTISED-VS-DECLARED WALK: a description is a PROMISE to the model exactly as
// `input_schema` is, so every advertised parameter token must resolve to the declared surface
// or a ruling. Runtime defs only: a static scan cannot see the spread twins or injected props.

export interface AdvertisementContext {
  /** Every live tool name: a description may legitimately name another tool. */
  toolNames: ReadonlySet<string>;
  /** Tool name -> its declared property names, so a cross-tool reference resolves. */
  declaredByTool: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * A token ADVERTISED as a parameter: a backticked identifier, or `name=<value>` (both shapes
 * from the real corpus). Bare prose is NOT a shape: it names no parameter, drowns the findings.
 */
const ADVERTISED_TOKEN =
  /`([a-z][a-z0-9]*(?:_[a-z0-9]+)*)`|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\s*=\s*(?:["'“]|true\b|false\b|\d)/g;

/** How far back a tool name may sit and still own the token after it. */
const CROSS_TOOL_WINDOW = 70;

export function describedStrings(def: Pick<ToolDefinition, 'description' | 'input_schema'>): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  if (typeof def.description === 'string' && def.description) out.push({ where: 'description', text: def.description });
  const recurse = (node: unknown, prefix: string): void => {
    const props = (node as { properties?: unknown } | undefined)?.properties;
    if (!props || typeof props !== 'object') return;
    for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
      const child = raw as { description?: unknown; items?: unknown; properties?: unknown } | undefined;
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof child?.description === 'string' && child.description) {
        out.push({ where: `properties.${path}.description`, text: child.description });
      }
      if (child?.properties) recurse(child, path);
      if (child?.items) recurse(child.items, `${path}[]`);
    }
  };
  recurse(def.input_schema, '');
  return out;
}

export function declaredEnumValues(def: Pick<ToolDefinition, 'input_schema'>): Set<string> {
  const out = new Set<string>();
  const recurse = (node: unknown): void => {
    const props = (node as { properties?: unknown } | undefined)?.properties;
    if (!props || typeof props !== 'object') return;
    for (const raw of Object.values(props as Record<string, unknown>)) {
      const child = raw as { enum?: unknown; items?: unknown; properties?: unknown } | undefined;
      if (Array.isArray(child?.enum)) for (const v of child.enum) out.add(String(v));
      if (child?.properties) recurse(child);
      if (child?.items) recurse(child.items);
    }
  };
  recurse(def.input_schema);
  return out;
}

/**
 * THE WALK. Clause 9: every advertised token is a property of this schema at any depth, an
 * enum VALUE declared, another live tool's name, that tool's parameter named within
 * CROSS_TOOL_WINDOW characters, or a ruling with a reason. Clause 9b: stale rulings (token
 * no longer advertised, or now declared) fail, as `nonEffects` rulings already do.
 */
export function checkAdvertisedParameters(def: ToolDefinition, ctx: AdvertisementContext): ConformanceProblem[] {
  const problems: ConformanceProblem[] = [];
  const tool = def.name;
  const push = (clause: string, detail: string): void => { problems.push({ tool, clause, detail }); };

  const declared = new Set(walkSchemaFields(def).map((f) => leafFieldName(f.path)));
  const enums = declaredEnumValues(def);
  const rulings = def.advertisedNotDeclared ?? {};
  const texts = describedStrings(def);
  const advertised = new Set<string>();

  for (const { where, text } of texts) {
    ADVERTISED_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ADVERTISED_TOKEN.exec(text))) {
      const token = m[1] ?? m[2];
      if (!token) continue;
      advertised.add(token);
      if (declared.has(token) || enums.has(token) || ctx.toolNames.has(token)) continue;

      const before = text.slice(Math.max(0, m.index - CROSS_TOOL_WINDOW), m.index);
      let crossReferenced = false;
      for (const [other, otherProps] of ctx.declaredByTool) {
        if (other === tool) continue;
        if (!before.includes(other)) continue;
        if (otherProps.has(token)) { crossReferenced = true; break; }
      }
      if (crossReferenced) continue;

      const reason = rulings[token];
      if (reason !== undefined) {
        if (reason.trim() === '') {
          push('9 advertised resolves', `advertisedNotDeclared["${token}"] has no reason — a ruling with no reason is silence`);
        }
        continue;
      }
      push(
        '9 advertised resolves',
        `${where} advertises "${token}", which is not a property of this tool's input_schema, ` +
        `not an enum value it declares, and not another tool's parameter named beside it — ` +
        `declare it, correct the text, or rule it in advertisedNotDeclared with the reason`,
      );
    }
  }

  for (const [token, reason] of Object.entries(rulings)) {
    if (declared.has(token)) {
      push('9b ruling is live', `advertisedNotDeclared["${token}"] is STALE — this tool now DECLARES that property, so the ruling excuses a promise it is keeping`);
    } else if (!advertised.has(token)) {
      push('9b ruling is live', `advertisedNotDeclared["${token}"] is STALE — no description on this tool advertises "${token}" any more`);
    }
    if (typeof reason !== 'string') {
      push('9b ruling is live', `advertisedNotDeclared["${token}"] carries no reason string`);
    }
  }

  return problems;
}

/**
 * THE WALK; empty array passes. Clause 1: a missing `effects` is a refusal (a spread that drops
 * it trips here). 2-5: kinds, `from` prefixes with non-empty targets, `args.<path>` and
 * `nonEffects` keys resolve, each ruling with a reason; a renamed field fails the build instead
 * of quietly un-declaring an effect.
 * 6 (tripwire): every resource-shaped field covered by an effect or a ruling. 7/7b: `fields`
 * keys resolve; `requiredNotEnforced` needs a reason and a truly required field. 8: no
 * declaration key inside `input_schema`, which goes to the provider verbatim, golden-hashed.
 */
export function checkEffectDeclarations(def: ToolDefinition): ConformanceProblem[] {
  const problems: ConformanceProblem[] = [];
  const tool = def.name;
  const push = (clause: string, detail: string): void => { problems.push({ tool, clause, detail }); };

  if (!Array.isArray(def.effects)) {
    push('1 declared', 'no `effects` declaration at all (declare the effects, or `effects: []` to state it touches nothing a broker owns)');
    return problems; // nothing else can be judged
  }

  const fields = walkSchemaFields(def);
  const paths = new Set(fields.map((f) => f.path));

  for (const effect of def.effects) {
    if (!EFFECT_KINDS.includes(effect.kind)) {
      push('2 kind', `effect kind "${String(effect.kind)}" is not one of ${EFFECT_KINDS.join(', ')}`);
    }
    const from = String(effect.from ?? '');
    const isArgs = from.startsWith(EFFECT_FROM_ARGS);
    const isFixed = from.startsWith(EFFECT_FROM_FIXED);
    const isDerived = from.startsWith(EFFECT_FROM_DERIVED);
    if (!isArgs && !isFixed && !isDerived) {
      push('3 from', `effect ${effect.kind} has from="${from}", which starts with none of "${EFFECT_FROM_ARGS}", "${EFFECT_FROM_FIXED}", "${EFFECT_FROM_DERIVED}"`);
      continue;
    }
    if (isFixed || isDerived) {
      if (from.slice(from.indexOf(':') + 1).trim() === '') {
        push('3 from', `effect ${effect.kind} has from="${from}" with an empty target — say what it touches`);
      }
      continue;
    }
    const argPath = from.slice(EFFECT_FROM_ARGS.length);
    if (!paths.has(argPath)) {
      push('4 arg resolves', `effect ${effect.kind} names args.${argPath}, which is not a property of this tool's input_schema`);
    }
  }

  for (const [path, reason] of Object.entries(def.nonEffects ?? {})) {
    if (!paths.has(path)) {
      push('5 ruling resolves', `nonEffects names "${path}", which is not a property of this tool's input_schema`);
    }
    if (!reason || reason.trim() === '') {
      push('5 ruling resolves', `nonEffects["${path}"] has no reason — a ruling with no reason is silence`);
    }
  }

  const declaredArgPaths = new Set(
    def.effects
      .map((e) => String(e.from ?? ''))
      .filter((f) => f.startsWith(EFFECT_FROM_ARGS))
      .map((f) => f.slice(EFFECT_FROM_ARGS.length)),
  );
  const ruled = new Set(Object.keys(def.nonEffects ?? {}));
  // A container is covered by a declaration on anything INSIDE it (`args.files[].path`
  // covers `files`); anything else forces a redundant declaration per array/object.
  const coveredBySelfOrDescendant = (path: string): boolean => {
    for (const declared of [...declaredArgPaths, ...ruled]) {
      if (declared === path) return true;
      if (declared.startsWith(`${path}[`) || declared.startsWith(`${path}.`)) return true;
    }
    return false;
  };
  for (const field of fields) {
    if (!EFFECTFUL_FIELD_NAMES.has(leafFieldName(field.path))) continue;
    if (coveredBySelfOrDescendant(field.path)) continue;
    push('6 tripwire', `"${field.path}" looks like a resource and this definition declares nothing for it — declare the effect, or rule it inert in nonEffects with the reason`);
  }

  for (const path of declaredSecretFields(def)) {
    if (!paths.has(path)) {
      push('7 secret resolves', `fields["${path}"] is declared secret but is not a property of this tool's input_schema`);
    }
  }

  // Clause 7b covers EVERY `fields` key (not only secret ones): the validation boundary reads
  // `allowEmpty`/`requiredNotEnforced` off this map by name, so a rename fails here, not a silent drop.
  for (const [path, decl] of Object.entries(def.fields ?? {})) {
    if (!paths.has(path)) {
      push('7b field resolves', `fields["${path}"] is declared but is not a property of this tool's input_schema`);
      continue;
    }
    if (decl?.requiredNotEnforced !== undefined) {
      if (String(decl.requiredNotEnforced).trim() === '') {
        push('7b field resolves', `fields["${path}"].requiredNotEnforced has no reason — a ruling with no reason is silence`);
      }
      if (!def.input_schema.required.includes(path)) {
        push('7b field resolves', `fields["${path}"].requiredNotEnforced declares an exemption for a field that is not in input_schema.required`);
      }
    }
  }

  const schemaJson = JSON.stringify(def.input_schema);
  for (const forbidden of ['"effects"', '"nonEffects"', '"secret"', '"advertisedNotDeclared"']) {
    if (schemaJson.includes(`${forbidden}:`)) {
      push('8 off the wire', `${forbidden} appears inside input_schema, which is serialized to the provider verbatim — declarations are siblings of input_schema, never children (OR7 cache-prefix law)`);
    }
  }

  return problems;
}
