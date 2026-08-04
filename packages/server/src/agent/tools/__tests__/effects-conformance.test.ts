// ════════════════════════════════════════════════════════════════════════════
// THE EFFECTS-DECLARATION CONFORMANCE WALK (PHASE-5 T1 Step 1)
//
// Every tool definition the platform can expose declares what it does to the
// world, or it does not ship. This is the failing test that came first: at
// `d0b3320` not one of the 320 definitions carried an `effects` declaration and
// every clause below was red.
//
// The walk runs over `getAllToolDefinitions()` — the RUNTIME surface, 437
// definitions, because the 117 `user_*` twins are spread-copies generated at
// module load and a walk over source files would never see them. Clause "twins
// inherit" is the one that proves the spread carries the declaration rather
// than assuming it: §T0-PINS P3 says 13 effectful defs get twins, and a spread
// that lost `effects` would leave 13 undeclared tools live on the wire.
//
// Why importing the definitions leaf is safe here: `tools/__tests__/tool-list-
// conformance.test.ts` records that importing the old tool hub standalone hangs
// on a module-init cycle. Re-derived at `d0b3320` — it did not; the import
// resolved in ~2s and returned 437 definitions, and that comment was recorded
// as stale in the T1 report rather than propagated. PHASE-5 T4 settles the
// question structurally: `agent/tools/definitions.ts` is the wire array and
// the fifteen family arrays, with no dispatcher and no handler in its graph.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllToolDefinitions, toolDefinitions } from '../definitions.js';
import { unknownArgsAgainstSchema } from '../index.js';
import {
  checkAdvertisedParameters,
  checkEffectDeclarations,
  describedStrings,
  declaredSecretFields,
  walkSchemaFields,
  type AdvertisementContext,
  type ConformanceProblem,
} from '../effect-conformance.js';

const ALL = getAllToolDefinitions();
const BASE = ALL.filter((d) => !d.name.startsWith('user_'));
const TWINS = ALL.filter((d) => d.name.startsWith('user_'));

/**
 * TOOLS WHOSE REAL EFFECT HAS NO RESOURCE ARGUMENT. No argument scan of any
 * depth can reach these, which is the whole reason the declaration is the
 * source of truth rather than the scan. The first block is §T0-PINS P3's own
 * enumeration, pinned verbatim so the plan's completion proof is a test. The
 * second is what re-deriving it at `d0b3320` added — read from the
 * implementations, not from the schemas:
 *   * all eight Plaud tools run `npx -y @plaud-ai/cli@latest` per call
 *     (`plaud/client.ts:24`), a network-fetched package executed as a
 *     subprocess, and the survey's list does not name them;
 *   * `tunnel` spawns `cloudflared` and can `brew install` it
 *     (`services/tunnel.ts:290-299,397,525`);
 *   * `apply_update` runs the curl → unzip → rsync → npm install path over the
 *     running install (`gateway/routes/update.ts:560-630`);
 *   * the four media generators write their artifact into the calling agent's
 *     uploads directory;
 *   * the remaining technique verbs read or write the technique directory.
 */
const ARGUMENTLESS_EFFECTS_PINNED_BY_T0 = [
  'web_search', 'spawn_agent',
  'mouse_click', 'mouse_move', 'keyboard_type', 'screen_screenshot',
  'imessage_list_contacts', 'teams_send_message', 'broadcast_to_group',
  'credential_add', 'credential_get', 'credential_update', 'credential_delete', 'credential_list',
  'technique_set_placeholder', 'technique_finalize', 'use_technique',
];
const ARGUMENTLESS_EFFECTS_DERIVED_AT_T1 = [
  'plaud_list_recordings', 'plaud_recent_recordings', 'plaud_search_recordings',
  'plaud_get_recording', 'plaud_get_transcript', 'plaud_get_summary',
  'plaud_get_audio_url', 'plaud_account_info',
  'tunnel', 'screen_broadcast', 'apply_update', 'check_for_update',
  'image_create', 'tts_create', 'music_create', 'video_create',
  'list_techniques', 'publish_technique', 'submit_technique_for_review',
  'delete_technique', 'technique_list_versions', 'technique_read', 'save_technique',
  'update_technique',
];

/**
 * THE DECLARED SECRET FIELDS, pinned. PHASE-4 T5b derived these three by
 * reading every definition; they were a hand-maintained map in
 * `credentials/secret-fields.ts` that nothing checked (P4 exit §8 item 2). The
 * map is now a READER of these declarations, and this clause is what makes a
 * new secret-bearing field a build failure instead of a leak.
 */
const DECLARED_SECRET_FIELDS: ReadonlyArray<[string, string]> = [
  ['credential_add', 'credentials'],
  ['credential_update', 'credentials'],
  ['technique_set_placeholder', 'value'],
];

function format(problems: ConformanceProblem[]): string {
  return problems.map((p) => `  ${p.tool} [clause ${p.clause}] ${p.detail}`).join('\n');
}

// ── PHASE-6 T0C: SURFACE 2, the parameters handlers actually READ ────────────
// The gap this task was sent to close: `validateToolArgs` covers only
// `input_schema.required` for the 57 boundary-validated names and says nothing
// about optional parameters, and `checkRequired` is still hand-written at 19
// work-verb sites. Nothing anywhere derived "what does this handler read".

const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The modules that implement tool handlers — where `args` means TOOL args. */
const HANDLER_CORPUS = [
  'agent/tools', 'agent/brokers', 'tracker', 'google', 'microsoft', 'credentials', 'plaud', 'tools', 'agent/pdf-tools.ts',
];

/**
 * READ NAMES THAT NO DEFINITION DECLARES, RULED. Kept deliberately tiny: at T0C
 * the tool-handler corpus produced SEVEN, of which four were the two verified
 * seeds and three are these. A ruling here is a fact about the tree, and the
 * clause fails if it stops being one.
 */
const READ_BUT_UNDECLARED_RULED: Readonly<Record<string, string>> = {
  js: 'not a parameter — an ES module specifier (`from \'./args.js\'`) that the read scan sees as `args.js`',
  __malformed_args: 'the engine\'s own marker for unparseable tool-call JSON, stripped by the same `__` rule the unknown-arg warning uses',
  command: 'the LEGACY exec spelling, read at `agent/brokers/exec-seam.ts` on purpose and with its reason at the site: `exec` declares `argv` since PHASE-5 T3, and a replayed transcript or a stored approval row can still carry `{command}`. Declaring it would re-advertise the shell door this phase closed',
  local_time: 'PHASE-6 T0C seed 1, HANDED UP: read at `tracker/tools.ts` and fully supported end to end, declared on no tool and forwarded by no door. Declaring it moves the cache-prefix reference file, which is a reviewed re-blessing and the owner\'s call',
  local_timezone: 'PHASE-6 T0C seed 1, HANDED UP — see `local_time`',
  tz: 'PHASE-6 T0C seed 1, HANDED UP — see `local_time`. Also the name of the zero-reader spine column T0A dispositioned to SWEEP-F',
  revert_to_original: 'PHASE-6 T0C seed 2, HANDED UP: the byte-identical-revert refusal at `tracker/tools.ts` names it as the escape hatch and no door can forward it. Declaring it moves the cache-prefix reference file',
};

/**
 * TOKENS A HANDLER'S MODEL-FACING TEXT NAMES IN `name=value` SHAPE THAT NO
 * DEFINITION DECLARES, RULED. Every entry is a fact about the tree and the
 * clause fails when it stops being one.
 *
 * WHY THIS HALF IS DERIVED FROM SOURCE WHILE THE REST OF THE CENSUS IS NOT:
 * the definition surface HAS a runtime representation (`getAllToolDefinitions()`)
 * and a source scan of it provably lies — it cannot see the 117 `user_` twins or
 * the injected `account` property. Handler error and echo strings have no runtime
 * enumeration at all: they exist only when their own branch fires, and driving
 * every refusal path of 438 tools is not a census, it is a fleet. So this clause
 * reads the modules that EMIT those strings and compares them against the runtime
 * declaration — the comparison target is still the 438.
 */
const HANDLER_TEXT_RULED: Readonly<Record<string, { sites: number; reason: string }>> = {
  local_time: {
    sites: 3,
    reason:
      'PHASE-6 T0C: the three surviving `local_time=` sites are all inside `resolveLocalWallClock` — reachable ONLY when the caller already passed the field, i.e. over HTTP, where it works end to end. The three MODEL-FACING sites were corrected in this task: the success echo on every scheduled create AND edit, the ASK_USER text, and the unparseable-`when` error. THE COUNT IS THE PIN: re-add one and this clause fails, which is the whole point — `local_time` is declared on no tool and forwarded by no door, so a model that obeyed got the unknown-argument warning and a silently dropped field. (`local_timezone` needs no entry: its one remaining site says "Pass local_timezone (IANA…)" in prose rather than `name=value` shape, and the READ census rules it instead.)',
  },
  awaiting_user_verdict: { sites: 1, reason: 'a WORK-ROW state flag reported to the model ("while awaiting_user_verdict=1 the PM will leave this task alone"), not a parameter it is being asked to pass' },
  complete_validated: { sites: 1, reason: 'a work-row state flag reported in a no-op notice, not a parameter' },
  blocked_validated: { sites: 1, reason: 'a work-row state flag reported in a no-op notice, not a parameter' },
  trashed: { sites: 2, reason: "a Google Drive API query term (`trashed=false`) inside the provider's own search string, not a parameter of any tool" },
  top: { sites: 6, reason: 'the Microsoft Graph `$top` query parameter inside a provider URL, not a parameter of any tool' },
  boundary: { sites: 1, reason: 'the MIME multipart boundary in a Google upload request header, not a parameter of any tool' },
};

const toCamel = (k: string): string => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const toSnakeName = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === '__tests__' || e === 'migrations' || e === 'node_modules') continue;
      tsFilesUnder(p, acc);
    } else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

/**
 * Every parameter a MODEL-FACING string literal in these roots advertises, in the
 * one shape that is unambiguously an instruction to pass something: `name=<value>`
 * inside prose. A bare backticked word is deliberately not a shape here — handler
 * text quotes column names, tool names and enum values constantly, and a scan that
 * flagged them would need more excuses than facts. SQL is excluded because a
 * `WHERE x = 1` fragment is not a sentence addressed to a model.
 */
function advertisedInProseFrom(...roots: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // Normalized so a SOURCE literal and the RUNTIME string it becomes compare
  // equal: the source carries `\'` and `\n` where the runtime carries an
  // apostrophe and a real newline.
  const norm = (s: string): string => s.replace(/\\n/g, '').replace(/\\/g, '').replace(/\s+/g, '');
  const declaredText = new Set(ALL.flatMap((d) => describedStrings(d).map((x) => norm(x.text))));
  const literal = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  const advert = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\s*=\s*(?:["'\\]|true\b|false\b|\d)/g;
  const sql = /\b(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM|JOIN|ORDER BY|GROUP BY)\b/;
  for (const root of roots) {
    const files = root.endsWith('.ts') ? [root] : tsFilesUnder(root);
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;   // a comment tells the model nothing
        // A DECLARED description IS the other surface, and the clause above
        // already judges it against the runtime definition with the rules that
        // surface needs (enum values, cross-tool references, negative
        // advertisements). Judging it twice, here, with a blunter rule is the
        // second-mechanism disease — so a literal that IS one of the 2,082
        // runtime description strings is skipped, by identity rather than by
        // guessing at its syntax. What remains is the OTHER text: what a handler
        // says when it refuses, echoes or explains.
        literal.lastIndex = 0;
        let lit: RegExpExecArray | null;
        while ((lit = literal.exec(line))) {
          const text = lit[1] ?? lit[2] ?? lit[3] ?? '';
          if (text.length < 8 || !/\s/.test(text) || sql.test(text)) continue;
          if (declaredText.has(norm(text))) continue;
          advert.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = advert.exec(text))) {
            const site = `${f.slice(SERVER_SRC.length + 1)}:${i + 1}`;
            const seen = out.get(m[1]) ?? [];
            if (!seen.includes(site)) seen.push(site);
            out.set(m[1], seen);
          }
        }
      });
    }
  }
  return out;
}

/**
 * Every name read off an `args` object in the given roots. Four spellings, all
 * present in this tree: `args.foo`, `args['foo']`, `(args as X).foo`, and
 * `const { foo } = args`. The cast spelling is the one that matters most — it is
 * how `approve_destructive_action` reads BOTH its parameters, and a census blind
 * to it reports a live tool as declaring two dead ones.
 */
function readArgNamesFrom(...roots: string[]): Set<string> {
  const out = new Set<string>();
  const patterns = [
    /\bargs\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bargs\[\s*['"]([^'"]+)['"]\s*\]/g,
    /\bargs\s+as\s+[^)]*\)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    /\bargs\s+as\s+[^)]*\)\s*\[\s*['"]([^'"]+)['"]\s*\]/g,
  ];
  const destructure = /(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:ctx\.)?args\b/g;
  for (const root of roots) {
    const files = root.endsWith('.ts') ? [root] : tsFilesUnder(root);
    for (const f of files) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;   // a comment reads nothing
        for (const re of patterns) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(line))) out.add(m[1]);
        }
        destructure.lastIndex = 0;
        let d: RegExpExecArray | null;
        while ((d = destructure.exec(line))) {
          for (const raw of d[1].split(',')) {
            const n = raw.split(':')[0].trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) continue;   // `...rest` is not a parameter
            out.add(n);
          }
        }
      }
    }
  }
  return out;
}

describe('effects-declaration conformance walk (PHASE-5 T1)', () => {
  // PHASE-5 T3 moved these by exactly ONE, and the delta is named rather than
  // re-baselined: `shell({script})` is a NEW tool definition — the second exec
  // door — so the static census is T0's 320 + 1 and the runtime census is 437 + 1.
  // The twin count is untouched, which is the check that the new definition did
  // not accidentally acquire a `user_` twin.
  it('the census is T0\'s 320 static definitions + T3\'s `shell`, 117 user_ twins, 438 at runtime', () => {
    expect(BASE.length).toBe(321);
    expect(BASE.filter((d) => d.name === 'shell')).toHaveLength(1);
    expect(TWINS.length).toBe(117);
    expect(ALL.length).toBe(438);
    expect(new Set(ALL.map((d) => d.name)).size).toBe(438);
  });

  it('EVERY definition declares its effects, and every declaration is well formed', () => {
    const problems = ALL.flatMap((def) => checkEffectDeclarations(def));
    expect(problems.length, `${problems.length} conformance problem(s) across ${ALL.length} definitions:\n${format(problems)}`).toBe(0);
  });

  it('no definition is missing the declaration outright', () => {
    const undeclared = ALL.filter((d) => !Array.isArray(d.effects)).map((d) => d.name);
    expect(undeclared, `${undeclared.length} definition(s) carry no effects declaration`).toEqual([]);
  });

  it('the effects with NO resource argument are declared — the class no field scan can reach', () => {
    const byName = new Map(ALL.map((d) => [d.name, d]));
    const missing: string[] = [];
    for (const name of [...ARGUMENTLESS_EFFECTS_PINNED_BY_T0, ...ARGUMENTLESS_EFFECTS_DERIVED_AT_T1]) {
      const def = byName.get(name);
      expect(def, `${name} is pinned as effectful but is not a live tool definition`).toBeDefined();
      if (!def) continue;
      if (!def.effects || def.effects.length === 0) missing.push(name);
    }
    expect(missing, `these tools have a real effect and declare none: ${missing.join(', ')}`).toEqual([]);
  });

  it('the user_ twins INHERIT the declaration through the generation spread', () => {
    const byName = new Map(ALL.map((d) => [d.name, d]));
    const broken: string[] = [];
    let effectfulTwins = 0;
    for (const twin of TWINS) {
      const base = byName.get(twin.name.slice('user_'.length));
      expect(base, `twin ${twin.name} has no base definition`).toBeDefined();
      if (!base) continue;
      if (JSON.stringify(twin.effects ?? null) !== JSON.stringify(base.effects ?? null)) broken.push(twin.name);
      if ((twin.effects?.length ?? 0) > 0) effectfulTwins++;
    }
    expect(broken, `twin(s) whose effects differ from their base: ${broken.join(', ')}`).toEqual([]);
    // §T0-PINS P3 predicted 13 effectful twins (6 google-write + 7 microsoft-write),
    // counted from ITS effectful set, which was a field scan. Re-derived at T1
    // against the declarations the tools actually carry, it is 20: the extra
    // seven are the `send` effects a field scan cannot see —
    // google `calendar_create`, `calendar_respond_invite`, `drive_share`, and
    // microsoft `teams_create_chat`, `teams_send_message`,
    // `teams_send_channel_message`, `onedrive_share`. Recorded in T1's AS-BUILT
    // with the command; nothing was tuned to reach it.
    expect(effectfulTwins).toBe(20);
  });

  it('the effect surface is the size T1 derived, and every kind is in use or knowingly absent', () => {
    // Reported, never a gate on a number — but pinned so the next task inherits a
    // measurement rather than a rumour, and so a definition that quietly loses its
    // declaration in a later refactor shows up as an arithmetic change.
    //   105 of 321 base definitions declare at least one effect
    //   125 of 438 runtime definitions do (the 20 effectful user_ twins)
    //    14 definitions carry a nonEffects ruling
    // T3 moved both by exactly ONE: `shell({script})` is the new second exec
    // door and declares `shell`. `exec` itself did not change COUNT, it changed
    // KIND — `shell/args.command` became `proc/args.argv` — which is the whole
    // rebuild visible in one declaration.
    // T8 Step 3 moves both by ONE again, and it is the census doing its job
    // rather than a number being tuned: `history_get` has always read the stored
    // body of a `file_*` id off disk and declared NOTHING, so converting the
    // recall door to the facade refused it until the declaration was corrected
    // at the site (RULING P5-R14). A tool that gains a TRUE effect is the shape
    // of every remaining category, and each one shows up here by exactly its
    // own count.
    // §T0-PINS P3's "72 effectful defs" was a different unit: definitions carrying
    // an effectful-looking FIELD. Its own enumerated name list reproduces as 64
    // under a recursive scan here; the 104 adds the classes no scan reaches.
    // T8 Step 3 moves both by ONE a second time, for the same reason:
    // `load_tool_docs` reads the generated tool-doc file off disk and declared
    // nothing, so the surface split (RULING P5-R15 part 2) refused it until the
    // declaration was corrected at the site.
    // T8 Step 3 moves both by ONE a third time: `canvas_read` declared
    // `effects: []` and has always read the file on the agent's own canvas.
    // T8 Step 3, the slides door: +17 in one category, and it is the largest
    // single correction this task has made. Every `slides_*` verb declared
    // `effects: []` while ~16 of them read the PERSISTED DECK STYLE off disk and
    // two write it; `slides_export_pngs` writes a PNG per slide into the agent's
    // uploads directory; `slides_build_slide` reads a local image named one level
    // inside an element. Converted as-is, the first style read would have been
    // refused and every deck would have silently fallen back to the default
    // preset — a capability loss with no error anywhere.
    const effectful = BASE.filter((d) => d.effects.length > 0);
    expect(effectful.length).toBe(125);
    expect(ALL.filter((d) => d.effects.length > 0).length).toBe(145);
    // T8 Step 3 moves this by EIGHT, and the tripwire is what earned it:
    // `pdf_create.filename` and the seven `output_filename` siblings are BARE
    // NAMES, not paths. Their old `fs_write from: args.<name>` declaration
    // resolved to a file in the server's working directory that the tool never
    // touches, while the real write went undeclared. With the real target now
    // declared (the agent uploads tree), clause 6 asked what the name itself is
    // — and `inert, with the reason` is the true answer.
    // T8 Step 3 moves it by ONE more, and it is the same class a third time:
    // `technique_read.file` is a RELATIVE name inside the technique directory,
    // not a path. With the real read declared (the technique tree the reference
    // resolves to — RULING P5-R15 ADDENDUM 3(1)(a)), clause 6 asked what the
    // relative name itself is, and `inert, with the reason` is the true answer.
    // `update_technique.files[].path` is the same correction, on a definition
    // that already carried a ruling, so it moves no count here.
    // T8 Step 3, the office door: +1. `office_create_spreadsheet` gains its first
    // ruling because `filename` is the same BARE NAME the PDF door carried — its
    // two create siblings already had a `nonEffects` block, so they move nothing.
    expect(BASE.filter((d) => d.nonEffects).length).toBe(24);

    const kindsInUse = new Set(BASE.flatMap((d) => d.effects.map((e) => e.kind)));
    // `fs_delete` and `spawn` are single-member classes today; since T3 so are
    // `proc` (exec) and `shell` (the shell tool). Each is named here so a future
    // zero reads as a deletion, not a gap.
    expect([...kindsInUse].sort()).toEqual(
      ['applescript', 'fs_delete', 'fs_read', 'fs_write', 'net', 'proc', 'secrets', 'send', 'shell', 'spawn'],
    );
  });

  it('the declared secret fields are exactly the three PHASE-4 T5b derived, and each resolves', () => {
    const found: Array<[string, string]> = [];
    for (const def of BASE) {
      for (const field of declaredSecretFields(def)) found.push([def.name, field]);
    }
    found.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    const expected = [...DECLARED_SECRET_FIELDS].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    expect(found).toEqual(expected);
  });

  it('a declaration never reaches the wire: no effects/nonEffects/secret key inside any input_schema', () => {
    // The provider payload is `{name, description, input_schema}` (model.ts:2297)
    // and the cache-prefix golden hashes exactly that. This clause is the reason
    // `secret: true` is a sibling of input_schema rather than a property of the
    // field it describes, which is where it would naturally have gone.
    const leaked = ALL.filter((d) => /"(effects|nonEffects|secret)":/.test(JSON.stringify(d.input_schema))).map((d) => d.name);
    expect(leaked, `declaration keys leaked into the provider payload for: ${leaked.join(', ')}`).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE-6 T0C — THE ADVERTISED-VS-ACTUAL SURFACE, ON THE SAME 438-DEFINITION
  // WALK. The owner's third-ordered task, in his words: "go through all the
  // tools to see what else they are missing… descriptions and hints not matching
  // actual parameters."
  //
  // Four surfaces must agree per tool: (1) the declared `input_schema`, (2) what
  // the handler reads, (3) what the doors forward, (4) what the descriptions,
  // hints and error texts advertise. Surface 3 is held by T0A's door-forward
  // census (`door-forward-census.ts`, widened per door, never a second walk).
  // Surfaces 1, 2 and 4 are held here, on the walk that already runs over the
  // runtime surface — because a fifth mechanism doing the same job would be the
  // disease this overhaul exists to remove.
  // ══════════════════════════════════════════════════════════════════════════

  const ADVERT_CTX: AdvertisementContext = {
    toolNames: new Set(ALL.map((d) => d.name)),
    declaredByTool: new Map(
      ALL.map((d) => [d.name, new Set(walkSchemaFields(d).map((f) => f.path.split('.').pop()!.replace(/\[\]$/, '')))] as const),
    ),
  };

  it('SURFACE 4 vs 1 — every parameter a description advertises is one the tool declares', () => {
    // Measured at T0C: 438 definitions, 2,082 description strings, and the whole
    // runtime description surface is CLEAN — every flag the scan raises is a
    // cross-tool reference, an enum value, or an explicit NEGATIVE advertisement
    // ("there is NO `header_row` field"), and each of those has a rule or a
    // ruling. The owner's complaint is TRUE, and it is true of handler ERROR and
    // ECHO text, not of the descriptions — which is what the next clause holds.
    const problems = ALL.flatMap((def) => checkAdvertisedParameters(def, ADVERT_CTX));
    expect(problems.length, `${problems.length} advertised-vs-declared problem(s) across ${ALL.length} definitions:\n${format(problems)}`).toBe(0);
  });

  it('SURFACE 4 vs 1 — the walk really bites: an invented parameter in a description fails', () => {
    // Negative control. Without this, a clause that passes proves only that it
    // was never able to fail.
    const planted = { ...ALL[0], description: 'Set `definitely_not_a_real_param` to true.', advertisedNotDeclared: undefined };
    const problems = checkAdvertisedParameters(planted, ADVERT_CTX);
    expect(problems.map((p) => p.clause)).toContain('9 advertised resolves');
    // …and a ruling with a reason silences exactly that one, while a STALE
    // ruling for a token the text does not carry fails in the other direction.
    expect(checkAdvertisedParameters({ ...planted, advertisedNotDeclared: { definitely_not_a_real_param: 'planted' } }, ADVERT_CTX)).toEqual([]);
    const stale = checkAdvertisedParameters({ ...ALL[0], advertisedNotDeclared: { never_mentioned_anywhere: 'planted' } }, ADVERT_CTX);
    expect(stale.map((p) => p.clause)).toContain('9b ruling is live');
  });

  it('SURFACE 2 vs 1 — no tool declares a parameter that no handler ever reads', () => {
    // Direction (b) of the read census: dead advertisement. The corpus is the
    // WHOLE server source, deliberately — for "is it read at all?" the widest net
    // is the safe one, because a narrow net produces a false accusation.
    // Measured at T0C: 385 declared top-level property names across the 438
    // runtime definitions, and ZERO of them is read nowhere.
    const readNames = readArgNamesFrom(SERVER_SRC);
    const declaredNeverRead: string[] = [];
    for (const def of ALL) {
      for (const prop of Object.keys(def.input_schema.properties ?? {})) {
        if (readNames.has(prop) || readNames.has(toCamel(prop))) continue;
        declaredNeverRead.push(`${def.name}.${prop}`);
      }
    }
    expect(
      [...new Set(declaredNeverRead.map((s) => s.split('.')[1]))].sort(),
      `declared parameter(s) that no handler reads under any spelling: ${declaredNeverRead.join(', ')}`,
    ).toEqual([]);
  });

  it('SURFACE 2 vs 1 — every parameter a TOOL HANDLER reads is one some tool declares', () => {
    // Direction (a): the seed class. `tracker/tools.ts` reads `args.local_time`,
    // `args.local_timezone`, `args.tz` and `args.revert_to_original` — four names
    // no definition declares, advertised in the tool's own error and success text,
    // and reachable only over HTTP. The corpus here is the TOOL-HANDLER modules
    // only, deliberately the opposite choice from the clause above: for "is this
    // read name undeclared?" a wide net drags in every unrelated `args` object in
    // the tree, so each direction takes the corpus whose own failure mode is safe.
    const declared = new Set<string>();
    for (const def of ALL) for (const f of walkSchemaFields(def)) declared.add(f.path.split('.').pop()!.replace(/\[\]$/, ''));
    const readNames = readArgNamesFrom(...HANDLER_CORPUS.map((d) => join(SERVER_SRC, d)));
    const undeclared = [...readNames].filter((n) => !declared.has(n) && !declared.has(toSnakeName(n)) && !READ_BUT_UNDECLARED_RULED[n]).sort();
    expect(
      undeclared,
      `parameter name(s) a tool handler reads that NO definition declares: ${undeclared.join(', ')}`,
    ).toEqual([]);
    // Anti-rot, both directions: a ruling for a name that is now declared, or that
    // no handler reads any more, is an excuse rather than a fact.
    const staleRulings = Object.keys(READ_BUT_UNDECLARED_RULED)
      .filter((n) => declared.has(n) || !readNames.has(n)).sort();
    expect(staleRulings, `STALE read-census ruling(s): ${staleRulings.join(', ')}`).toEqual([]);
  });

  it('SURFACE 4 vs 1 — no HANDLER text tells a model to pass a parameter no tool declares', () => {
    // WHERE THE OWNER'S DEFECT ACTUALLY LIVES. The tool DESCRIPTIONS are clean
    // (the clause above, 2,082 strings, zero real mismatches); the lies were in
    // error and success-echo text. Two were verified seeds and both were live on
    // the most-read paths this tracker has: every scheduled create and edit ended
    // by telling the model to pass `local_time`, and the byte-identical-revert
    // refusal told it to re-call with `revert_to_original=true`. Neither is
    // declared on any tool, so a model that obeyed got the unknown-argument
    // warning, the field dropped, and the same refusal back.
    const declared = new Set<string>();
    for (const def of ALL) for (const f of walkSchemaFields(def)) declared.add(f.path.split('.').pop()!.replace(/\[\]$/, ''));
    const toolNames = new Set(ALL.map((d) => d.name));
    const advertised = advertisedInProseFrom(...HANDLER_CORPUS.map((d) => join(SERVER_SRC, d)));
    const promised = [...advertised.keys()]
      .filter((n) => !declared.has(n) && !declared.has(toSnakeName(n)) && !toolNames.has(n) && !HANDLER_TEXT_RULED[n])
      .sort();
    expect(
      promised,
      promised.map((n) => `  "${n}" advertised at ${advertised.get(n)!.join(', ')} — declared on no tool`).join('\n'),
    ).toEqual([]);
    // ANTI-ROT, AND THE COUNT IS PART OF THE RULING. A name-only ruling would
    // forgive a NEW site as readily as the ones it was written for — which is
    // exactly how the corrected `local_time` echo could come back unnoticed. So a
    // ruling pins how many sites it covers, and any change to that number is a
    // re-judgement rather than a silent pass.
    const stale = Object.entries(HANDLER_TEXT_RULED)
      .filter(([n, r]) => declared.has(n) || (advertised.get(n)?.length ?? 0) !== r.sites)
      .map(([n, r]) => `${n} (ruled ${r.sites}, found ${advertised.get(n)?.length ?? 0}${declared.has(n) ? ', and it is now DECLARED' : ''})`)
      .sort();
    expect(stale, `STALE handler-text ruling(s): ${stale.join('; ')}`).toEqual([]);
  });

  it('THE UNKNOWN-ARGUMENT WARNING IS BUILT FROM ALL 438, NOT THE CORE 112', () => {
    // THE STRUCTURAL FINDING, held so it cannot recur. The one runtime mechanism
    // that tells a model "that parameter is not in the schema" read the 112-entry
    // core array, so it was blind to 326 of 438 definitions — every Google,
    // Microsoft, Slides, Forms, PDF, Plaud and credentials tool and all 117 twins.
    // This is DRIVEN, not asserted about the source: a source-text check that "the
    // right identifier appears" is not the same as calling it for a tool outside
    // the core and reading the answer.
    expect(toolDefinitions.length).toBe(112);
    expect(ALL.length).toBe(438);

    const core = new Set(toolDefinitions.map((d) => d.name));
    const outsideCore = ALL.filter((d) => !core.has(d.name));
    expect(outsideCore.length).toBe(326);

    // One from each family the core array cannot see, plus a `user_` twin, which
    // exists only at module load and therefore only in the runtime map.
    for (const name of ['gmail_inbox', 'teams_send_message', 'slides_create_presentation', 'pdf_create', 'plaud_account_info', 'credential_list', 'user_gmail_inbox']) {
      const def = ALL.find((d) => d.name === name);
      expect(def, `${name} is expected outside the core 112 and must still be a live definition`).toBeDefined();
      const { declared, extras } = unknownArgsAgainstSchema(name, { definitely_not_declared: 1 });
      expect(declared, `${name}: the warning cannot see this definition at all`).not.toBeNull();
      expect(extras, `${name}: an undeclared argument produced no warning`).toEqual(['definitely_not_declared']);
    }

    // The engine's own markers are never the model's arguments, and a name that is
    // not a live definition warns about nothing (an unresolved alias, a tombstone).
    expect(unknownArgsAgainstSchema('gmail_inbox', { __malformed_args: 'x' }).extras).toEqual([]);
    expect(unknownArgsAgainstSchema('no_such_tool_at_all', { anything: 1 }).declared).toBeNull();
    // And the `account` property, injected into four families at module load, is
    // seen as declared — the exact property a source-text census cannot see.
    expect(unknownArgsAgainstSchema('gmail_inbox', { account: 'a@b.c' }).extras).toEqual([]);
  });

  it('the recursive walk really recurses — it sees a field two levels down', () => {
    // Negative control for the tripwire itself: a top-level property scan passes
    // `save_technique` while missing a git clone, which is §T0-PINS P3 finding 2.
    const saveTechnique = BASE.find((d) => d.name === 'save_technique');
    expect(saveTechnique).toBeDefined();
    const paths = walkSchemaFields(saveTechnique!).map((f) => f.path);
    expect(paths).toContain('dependencies.repos[].url');
    expect(paths).toContain('dependencies.models_or_assets[].destination');
    expect(paths).toContain('files[].path');
  });
});
