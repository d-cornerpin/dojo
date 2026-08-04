// ════════════════════════════════════════════════════════════════════════════
// THE DOOR-FORWARD CENSUS — ONE WALK, BUILT HERE FOR THE TRACKER DOORS.
// PHASE-6 T0A Step 2. Widened by T0C (the advertised-vs-actual tool-surface
// census); this file is the half T0A owes and T0C's Step 3 extends — NOT a
// second mechanism to be built beside it.
//
// ── THE QUESTION IT ANSWERS ─────────────────────────────────────────────────
// A tool's `input_schema` is a PROMISE to the model: pass this parameter and it
// will be honoured. Several handlers do not take `ctx.args` through to their
// inner function — they hand-pick fields into a NEW object — and every pick
// list is a chance for the promise and the code to disagree silently. They did:
// `work_update(action="edit")`'s list carried thirteen of the fifteen fields the
// tool's own refusal advertised, so an agent passing `anchor_time` (declared,
// described, read and applied by the layer underneath) got no error and no
// effect. Nothing failed. That is the shape this walk exists to make impossible.
//
// ── WHY IT PROBES AT RUNTIME RATHER THAN READING THE SOURCE ─────────────────
// A source scan of a forward list is a scan of ONE spelling of the mechanism —
// it cannot see a field forwarded by a normalisation branch further down (the
// tracker edit door forwards `repeat_days_of_week` that way) and it cannot see
// a `user_`-twin definition that exists only at module load. So the census
// DRIVES the door with a value for every declared parameter and reads what the
// inner function actually received. A census that greps is a census that lies.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
// For each door: every parameter the tool DECLARES is either FORWARDED, or it
// carries a written reason in `notForwarded`. Both directions are checked —
// a reason for a parameter that IS forwarded, or for one that is no longer
// declared, is STALE and fails too, so the list cannot rot into excuses (the
// same anti-rot rule the spine manifest and the wiring allowlist already have).
// ════════════════════════════════════════════════════════════════════════════

export interface DoorSpec {
  /** The dispatch key the executor routes into, e.g. `work_update:edit`. */
  door: string;
  /** The tool whose `input_schema` declares this door's promised surface. */
  tool: string;
  /** Args that ROUTE the call (the action/kind discriminator, the id). Merged over the probe. */
  baseArgs: Record<string, unknown>;
  /** Declared parameter -> the reason this door does not forward it. Both directions checked. */
  notForwarded: Record<string, string>;
}

export interface DoorCensus {
  door: string;
  declared: string[];
  forwarded: string[];
  /** Declared, not forwarded, and no reason written. THE DEFECT. */
  dropped: string[];
  /** A reason that no longer describes the tree. */
  staleReasons: string[];
}

/** camelCase -> snake_case, so `assignedTo` and `assigned_to` are one name. */
export function toSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * A value for a declared parameter, derived from ITS OWN SCHEMA rather than from
 * a hand-written table — a hand table is the second list this walk exists to
 * remove. Enum members take their first declared value; timestamps take a real
 * ISO instant, because a door that validates its input would otherwise refuse
 * the probe and the census would read "not forwarded" for the wrong reason.
 */
export function probeValue(name: string, schema: Record<string, unknown>): unknown {
  const enumValues = schema.enum as unknown[] | undefined;
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  const type = schema.type as string | undefined;
  if (type === 'number' || type === 'integer') return 1;
  if (type === 'boolean') return true;
  if (type === 'array') {
    const items = (schema.items ?? {}) as Record<string, unknown>;
    if (items.type === 'object') {
      const props = (items.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (items.required ?? Object.keys(props)) as string[];
      const one: Record<string, unknown> = {};
      for (const r of required) one[r] = probeValue(r, props[r] ?? { type: 'string' });
      return [one];
    }
    // Day-of-week lists are the only array of strings with a value constraint
    // that lives in prose rather than in `enum`; "mon" is valid for those and
    // inert for the id lists (`depends_on`), which forward verbatim.
    return ['mon'];
  }
  if (/(^|_)(time|start|at)$|^when$|^resume_at$/.test(name)) return '2026-08-05T13:00:00Z';
  return `probe-${name}`;
}

/** Every parameter the tool declares, from the RUNTIME definition. */
export function declaredParams(def: { input_schema?: { properties?: Record<string, unknown> } }): string[] {
  return Object.keys(def.input_schema?.properties ?? {});
}

/** The probe args for a door: a value per declared parameter, then its routing args on top. */
export function probeArgsFor(
  def: { input_schema?: { properties?: Record<string, Record<string, unknown>> } },
  spec: DoorSpec,
): Record<string, unknown> {
  const props = def.input_schema?.properties ?? {};
  const args: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(props)) args[name] = probeValue(name, schema);
  return { ...args, ...spec.baseArgs };
}

/**
 * Compare what the tool promises against what the door delivered.
 * `capturedKeys` are the keys of the object the inner function received.
 */
export function censusDoor(spec: DoorSpec, declared: string[], capturedKeys: string[]): DoorCensus {
  const forwarded = [...new Set(capturedKeys.map(toSnake))].sort();
  const forwardedSet = new Set(forwarded);
  const declaredSet = new Set(declared);
  const dropped = declared
    .filter((p) => !forwardedSet.has(p) && spec.notForwarded[p] === undefined)
    .sort();
  const staleReasons = Object.keys(spec.notForwarded)
    .filter((p) => forwardedSet.has(p) || !declaredSet.has(p))
    .sort();
  return { door: spec.door, declared: [...declared].sort(), forwarded, dropped, staleReasons };
}

/** The failure text a census clause prints — the numbers, the names, and the fix. */
export function formatCensus(c: DoorCensus): string {
  const lines = [`${c.door}: ${c.declared.length} declared / ${c.forwarded.length} forwarded`];
  if (c.dropped.length) {
    lines.push(
      `  ${c.dropped.length} DECLARED PARAMETER(S) SILENTLY DROPPED AT THE DOOR: ${c.dropped.join(', ')}`,
      '  Wire it through, or add it to notForwarded with the reason it does not belong here.',
    );
  }
  if (c.staleReasons.length) {
    lines.push(
      `  ${c.staleReasons.length} STALE reason(s) — forwarded now, or no longer declared: ${c.staleReasons.join(', ')}`,
      '  A reason that stopped being true is how a list of facts becomes a list of excuses.',
    );
  }
  return lines.join('\n');
}
