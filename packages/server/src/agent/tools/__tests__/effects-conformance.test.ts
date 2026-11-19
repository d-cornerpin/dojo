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
import { join } from 'node:path';
import { getAllToolDefinitions, toolDefinitions } from '../definitions.js';
import { unknownArgsAgainstSchema } from '../index.js';
import { checkAdvertisedParameters, checkEffectDeclarations, walkSchemaFields, type AdvertisementContext, type ConformanceProblem } from './effect-conformance.js';
import { declaredSecretFields } from '../registry.js';

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

describe('effects-declaration conformance walk (PHASE-5 T1)', () => {
  // PHASE-5 T3 moved these by exactly ONE, and the delta is named rather than
  // re-baselined: `shell({script})` is a NEW tool definition — the second exec
  // door — so the static census is T0's 320 + 1 and the runtime census is 437 + 1.
  // The twin count is untouched, which is the check that the new definition did
  // not accidentally acquire a `user_` twin.
  //
  // UX-REPAIR T77b moves both by exactly TWO, and the delta is named rather than
  // re-baselined: `gmail_draft` and `outlook_draft` are two NEW write definitions, and
  // each takes a `user_` twin from the full-parity loop its family already runs. So the
  // static census is 321 + 2 and the twin census is 117 + 2 — the twin count moving IS
  // the check that the loop reached them, the inverse of T3's check that `shell` did
  // not accidentally acquire one.
  //
  // DOJO-REPORT T3 moves the static and runtime censuses by exactly ONE and leaves the twin
  // census alone: `dojo_report` is a NEW core definition in `definitions.ts` with no `user_`
  // twin — it reaches no person on an owner channel, so the full-parity loop does not mint
  // one. TWINS.length holding at 119 IS the check that it did not accidentally acquire one,
  // the same check T3's `shell` earned.
  // t200 moves both by ONE the same way: `tool_result_read`, a core definition with no twin.
  // v3.5 inspect C1 moves both by ONE more: `dojo_inspect`, a core definition with no twin.
  // `technique_acknowledge` is not a tool: one fewer core definition, no twin.
  it('the census is T0\'s 320 static definitions + T3\'s `shell` + T77b\'s two drafts + DOJO-REPORT\'s `dojo_report` + t200\'s `tool_result_read` + K34\'s `lesson_record` + `dojo_inspect` + `continue_repeating`, less `technique_acknowledge`, 119 user_ twins, 446 at runtime', () => {
    expect(BASE.length).toBe(327);
    expect(BASE.filter((d) => d.name === 'dojo_inspect')).toHaveLength(1);
    expect(BASE.filter((d) => d.name === 'tool_result_read')).toHaveLength(1);
    expect(BASE.filter((d) => d.name === 'shell')).toHaveLength(1);
    expect(BASE.filter((d) => d.name === 'gmail_draft' || d.name === 'outlook_draft')).toHaveLength(2);
    expect(BASE.filter((d) => d.name === 'dojo_report')).toHaveLength(1);
    expect(TWINS.length).toBe(119);
    expect(ALL.length).toBe(446);
    expect(new Set(ALL.map((d) => d.name)).size).toBe(446);
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
    // T77b: 20 → 22. `gmail_draft` and `outlook_draft` each declare the `fs_read` their
    // `attachments` field earns, and each twin inherits it through the same spread. NOT a
    // `send` effect — a draft delivers to nobody — which is the arithmetic saying the
    // classification held. The draft's attachment read carries `leaves: true`: a read that
    // leaves the Mac, asked as a share, still not a send.
    expect(effectfulTwins).toBe(22);
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
    // T77b moves both by TWO: the two draft definitions, each with the `fs_read` its
    // `attachments` field earns, plus their two twins (127 base → 149 runtime).
    // DOJO-REPORT T3 moves both by ONE: `dojo_report` declares the single `fs_write` it
    // performs (the local evidence bundle). No twin, so base and runtime move together.
    // v3.5 inspect C1 moves both by ONE: `dojo_inspect` declares the node process its sql view runs.
    const effectful = BASE.filter((d) => d.effects.length > 0);
    expect(effectful.length).toBe(129);
    expect(ALL.filter((d) => d.effects.length > 0).length).toBe(151);
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
    // v3.5 inspect C1: +1. `dojo_inspect.path` names a file in the GitHub repo (read over HTTPS)
    // and `query` is a read-only statement; neither is a path on this machine.
    // v3.5 field fix 3 (audit #5): +1. `work_open` gains its first ruling (`tasks[].measure.args.path`,
    // the file-set measure's folder, authorized by the measure door with file_list's own gates);
    // `work_update` already carried a ruling, so its `measure.args.path` moves nothing here.
    // `gmail_read_attachment.filename` is the same bare name, ruled inert: +1.
    expect(BASE.filter((d) => d.nonEffects).length).toBe(27);

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

  it('THE UNKNOWN-ARGUMENT WARNING IS BUILT FROM ALL 438, NOT THE CORE 112', () => {
    // THE STRUCTURAL FINDING, held so it cannot recur. The one runtime mechanism
    // that tells a model "that parameter is not in the schema" read the 112-entry
    // core array, so it was blind to 326 of 438 definitions — every Google,
    // Microsoft, Slides, Forms, PDF, Plaud and credentials tool and all 117 twins.
    // This is DRIVEN, not asserted about the source: a source-text check that "the
    // right identifier appears" is not the same as calling it for a tool outside
    // the core and reading the answer.
    // DOJO-REPORT T3: core 112 → 113 and runtime 442 → 443. `dojo_report` is declared in
    // `definitions.ts`, so it lands INSIDE the core array — which is why `outsideCore`
    // below does not move. Both numbers moving together is the check on that claim.
    // t200: core 113 → 114 and runtime 443 → 444, `tool_result_read`, the same shape.
    // K34: core 114 → 115 and runtime 444 → 445, `lesson_record` (the Dreamer's door), no twin.
    // v3.5 inspect C1: core 115 → 116 and runtime 445 → 446, `dojo_inspect`, no twin.
    // `technique_acknowledge` is not a tool: core and runtime each one fewer, no twin.
    expect(toolDefinitions.length).toBe(116);
    expect(ALL.length).toBe(446);

    const core = new Set(toolDefinitions.map((d) => d.name));
    const outsideCore = ALL.filter((d) => !core.has(d.name));
    // T77b: 326 → 330, the four new draft names. They are provider tools, so they land
    // outside the core array exactly as every other Google/Microsoft tool does — which is
    // the property this clause exists to hold.
    expect(outsideCore.length).toBe(330);

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
