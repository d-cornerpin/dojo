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
// Why the import of `agent/tools.js` is safe here: `tools/__tests__/tool-list-
// conformance.test.ts` records that importing it standalone hangs on a
// module-init cycle. Re-derived at `d0b3320` — it does not; the import resolves
// in ~2s and returns 437 definitions. That comment is stale and is recorded as
// such in the T1 report rather than propagated.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { getAllToolDefinitions } from '../definitions.js';
import {
  checkEffectDeclarations,
  declaredSecretFields,
  walkSchemaFields,
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
    // §T0-PINS P3's "72 effectful defs" was a different unit: definitions carrying
    // an effectful-looking FIELD. Its own enumerated name list reproduces as 64
    // under a recursive scan here; the 104 adds the classes no scan reaches.
    const effectful = BASE.filter((d) => d.effects.length > 0);
    expect(effectful.length).toBe(105);
    expect(ALL.filter((d) => d.effects.length > 0).length).toBe(125);
    expect(BASE.filter((d) => d.nonEffects).length).toBe(14);

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
