// ════════════════════════════════════════════════════════════════════════════
// THE EFFECTS-DECLARATION WALK (PHASE-5 T1)
//
// One module, two readers: the conformance test that refuses an undeclared
// definition, and T7's effect-coverage exit gate, which the plan requires to
// report FROM THE REGISTRY and never from historical usage (research 19 §3.3).
//
// ── THE INVERSION, AND WHY IT HAD TO HAPPEN ──
// The plan's Step 1 asked for the opposite of what this module does: it named
// six field names (`path|file_path|paths|url|command|script`) and asked every
// definition whose schema mentioned one to declare an effect. Measured over all
// 320 definitions at `d0b3320`, that list matches 39 of them; it misses
// `file_paths`, which is `show_to_user`'s own field, and it cannot see
// `save_technique.dependencies.repos[].url` ("Git repos to clone") two levels
// down. Worse, a scan of ANY depth is structurally blind to the effects with no
// resource argument at all: `web_search` only ever reaches a fixed Brave host,
// `spawn_agent` creates a whole new effect surface, the four HID tools shell out
// to `cliclick`/`screencapture`, and all eight Plaud tools run
// `npx -y @plaud-ai/cli@latest` per call.
//
// So the DECLARATION on the definition is the source of truth, and this scan is
// a TRIPWIRE in the other direction: it asserts that no path/url/command-shaped
// field sits on a definition that says nothing about it. A field is "covered"
// by an effect that names it, or by a `nonEffects` ruling that says why it is
// inert. Silence is the only thing that fails.
// ════════════════════════════════════════════════════════════════════════════

import {
  EFFECT_FROM_ARGS,
  EFFECT_FROM_DERIVED,
  EFFECT_FROM_FIXED,
  EFFECT_KINDS,
  type ToolDefinition,
} from './types.js';

/**
 * FIELD NAMES THAT LOOK LIKE A RESOURCE. Every one was derived by reading all
 * 320 definitions at `d0b3320` — the plan's original six are the first row, the
 * rest are what a recursive walk of the real schemas turned up. The set is
 * deliberately generous: a false positive costs one `nonEffects` line with a
 * reason, a false negative costs an undeclared effect, and only one of those is
 * an incident.
 */
export const EFFECTFUL_FIELD_NAMES: ReadonlySet<string> = new Set([
  // the plan's own list
  'path', 'file_path', 'paths', 'url', 'command', 'script',
  // filesystem paths the plan's list misses
  'file_paths', 'attach_paths', 'input_paths', 'save_path', 'source_path',
  'image_path', 'install_to', 'install_in', 'destination', 'file', 'files',
  'output_filename', 'filename', 'entry_filename', 'attachments',
  // urls the plan's list misses
  'image_url', 'background_image_url', 'link_url', 'video_url', 'source_url',
]);

/** One property of a tool's input schema, at any depth. */
export interface SchemaField {
  /** Dotted path with `[]` for array elements: `dependencies.repos[].url`. */
  path: string;
  /** The declared JSON-schema type, or `?` when the property declares none. */
  type: string;
}

/**
 * Every property of a tool's input schema, recursively. Objects recurse through
 * `properties`; arrays yield their ELEMENT as `<path>[]` and then recurse into
 * it (whether or not the item declares `type: 'object'` — several schemas in
 * this tree declare `properties` on an item with no type, and a walk that
 * trusted `type` would have skipped `save_technique`'s repo clones).
 *
 * The element entry matters as much as the container: `imessage_send`'s
 * `attachments` is an array of absolute paths, and the thing a broker resolves
 * is each ELEMENT, so the declaration says `args.attachments[]` and this walk is
 * what makes that path real.
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

/** The leaf name of a dotted path: `dependencies.repos[].url` → `url`. */
export function leafFieldName(path: string): string {
  const last = path.split('.').pop() ?? path;
  return last.replace(/\[\]$/, '');
}

/** Does this definition's schema really contain this dotted path? */
export function schemaHasPath(def: Pick<ToolDefinition, 'input_schema'>, path: string): boolean {
  return walkSchemaFields(def).some((f) => f.path === path);
}

/** Every field this definition declares as carrying credential material. */
export function declaredSecretFields(def: Pick<ToolDefinition, 'fields'>): string[] {
  if (!def.fields) return [];
  return Object.entries(def.fields)
    .filter(([, decl]) => decl?.secret === true)
    .map(([path]) => path);
}

/** Problems found on one definition, each already phrased as a failure line. */
export interface ConformanceProblem {
  tool: string;
  clause: string;
  detail: string;
}

/**
 * THE WALK. Returns every problem on one definition; an empty array is a pass.
 *
 * Clause 1  a definition with NO `effects` array at all is a refusal — this is
 *           the one the plan's Step 1 is really about, and it is what a spread
 *           that drops the field or an `as ToolDefinition` cast would trip.
 * Clause 2  every declared `kind` is one of the declared kinds.
 * Clause 3  every `from` carries one of the three prefixes.
 * Clause 4  every `args.<path>` resolves to a real property of THIS tool's own
 *           schema — a renamed field then fails the build instead of quietly
 *           un-declaring an effect.
 * Clause 5  every `nonEffects` key resolves to a real property too, and carries
 *           a non-empty reason.
 * Clause 6  THE TRIPWIRE. Every resource-shaped field is covered by an effect
 *           that names it or by a ruling that explains it.
 * Clause 7  every declared secret field resolves to a real property.
 * Clause 7b every `fields` key resolves to a real property, and every
 *           `requiredNotEnforced` carries a reason AND names a genuinely
 *           required field (PHASE-5 T3 Step 3 — the validation boundary reads
 *           this map by field name, so a rename must fail the build).
 * Clause 8  the declarations stay OFF the wire: no `effects`, `nonEffects`,
 *           `fields` or `secret` key anywhere inside `input_schema`, because
 *           `input_schema` is passed to the provider verbatim and the
 *           cache-prefix golden hashes it (OR7 / roadmap #10).
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
  // A container is covered by a declaration on anything INSIDE it: declaring
  // `args.files[].path` says what `files` is for, and declaring
  // `args.attachments[]` says what `attachments` is for. Anything else would
  // force a second, redundant declaration per array and per nested object.
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

  // Clause 7b, PHASE-5 T3 Step 3: EVERY `fields` key resolves, not only the
  // secret ones. The validation boundary reads `allowEmpty` and
  // `requiredNotEnforced` off this map by field name, so a renamed property
  // would silently drop the declaration — and dropping `allowEmpty` turns a
  // working call into a refusal (`file_write({content: ""})`), which is the
  // exact class of silent capability loss this phase exists to prevent. A
  // `requiredNotEnforced` on a field that is not actually required is dead
  // paperwork claiming to be a decision, so it is caught here too.
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
  for (const forbidden of ['"effects"', '"nonEffects"', '"secret"']) {
    if (schemaJson.includes(`${forbidden}:`)) {
      push('8 off the wire', `${forbidden} appears inside input_schema, which is serialized to the provider verbatim — declarations are siblings of input_schema, never children (OR7 cache-prefix law)`);
    }
  }

  return problems;
}
