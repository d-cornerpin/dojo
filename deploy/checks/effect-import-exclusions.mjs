// ════════════════════════════════════════════════════════════════════════════
// THE `no-restricted-imports` EXCLUSION LIST (PHASE-5 T8 Step 4).
//
// The rule is `error` over `packages/server/src` and every file below is the
// exception, BY NAME and WITH ITS REASON. It is a list and never a directory
// heuristic, and the reason that is not a matter of taste:
//
//   MODULE-GRAPH REACHABILITY CANNOT EXPRESS THIS REQUIREMENT, and it was
//   MEASURED rather than assumed (T8H, transitive resolved-specifier walk from
//   `agent/tools/**`): 33 of the 37 platform-internal files below are reachable
//   in the import graph from the toolbox, because `logger.ts`, `db/connection.ts`
//   and `config/loader.ts` are reachable from everything. A computed set would
//   therefore exclude nearly the whole tree or nothing at all. The requirement
//   is not "which module can be imported" — it is *does this fs/proc call act on
//   a resource an AGENT can influence, in a context a dispatch opened?* That is a
//   reading, so it is written down.
//
// ── THE CLASSES, AND WHERE EACH CAME FROM ──
//   carrying-machinery       the layer everything else is funnelled INTO. It
//                            holds the imports on purpose; it is what performs
//                            the I/O behind the per-call capability.
//   agent-triggered          a tool call can make the code run, but every path
//                            and command is a PLATFORM LITERAL the agent cannot
//                            influence. Routing these through agent-facing
//                            brokers is refused by RULING P5-R12: it would
//                            record an agent-facing fs site that does not exist.
//   platform-internal        no tool path at all — boot, the database, the
//                            migration import/export, logging, the dashboard's
//                            own HTTP routes, dependency installers.
//   honest-label             ✅ OWNER DECIDED 2026-08-03 ("Earlier permission is
//                            enough"): agent-influenced resource, platform-timed
//                            execution — authorized when the agent asked, not
//                            re-checked when the platform acts. EVERY entry
//                            states its own RESIDUAL, because a label that hides
//                            what it costs is worse than no label.
//   named-exclusion          measured this task, converting refused with its
//                            reason recorded (RULING P5-R15 ADDENDUM 2's own
//                            sanctioned outcome).
//
// ── WHAT KEEPS THIS LIST HONEST ──
// `check-lint-baseline.mjs` censuses it on every gate run: an entry naming a
// file that does not exist FAILS; an entry naming a file that no longer holds a
// restricted import FAILS (a stale exclusion cannot rot into a permission); a
// file that holds one and is NOT here FAILS, naming the file. So the list is
// exactly the measured set, and adding to it is a hand edit somebody reviews.
//
// ── THE REFUSALS THAT SHAPED IT (RULING P5-R12, restated because they bind) ──
// Never move a site between classes to make the count fall. Never route
// platform-internal machinery through agent-facing brokers. Both were live
// temptations here and both were refused; the per-file `why` of every honest
// label says what was measured instead.
//
// PROVENANCE, said plainly: the class of every entry below is the classification
// two independent read-throughs produced at PHASE-5 T7 (`lint-baseline.json`
// `$classification-no-restricted-imports`) plus every amendment recorded since.
// This task re-derived the SET by the recorded command at its own HEAD with zero
// drift, and re-read from scratch only the files it acted on.
// ════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {{ file: string, klass: 'carrying-machinery'|'agent-triggered'|'platform-internal'|'honest-label'|'named-exclusion', why: string, residual?: string }} EffectImportExclusion
 */

/** @type {readonly EffectImportExclusion[]} */
export const EFFECT_IMPORT_EXCLUSIONS = [
  // ── THE CARRYING MACHINERY — the layer the surface is funnelled INTO ──────
  {
    file: 'agent/effects/fs.ts',
    klass: 'carrying-machinery',
    why: 'the fs half of the facade: it PERFORMS the filesystem work, and only on a resource the per-call capability the gate loop minted already names. This import is the point of the layer, not an exception to it.',
  },
  {
    file: 'agent/effects/proc.ts',
    klass: 'carrying-machinery',
    why: 'the proc half of the facade: the ONE place the platform spawns for an agent, buffered (execFile) and streaming (spawn), both behind the same capability. Asserted to be the only holder of node:child_process under agent/effects.',
  },
  {
    file: 'agent/effects/transcode.ts',
    klass: 'carrying-machinery',
    why: 'the temp-WORKSPACE carry (RULING P5-R15 ADDENDUM 4): transcribe_audio\'s decode and video demux moved here whole. Its fs reach is a temp PAIR in os.tmpdir() under platform-generated names that no scope template can name, so the pair is this layer\'s own implementation detail and the tool declares the PROGRAM instead (branch B).',
  },
  {
    file: 'agent/path-resolve.ts',
    klass: 'carrying-machinery',
    why: 'what the facade resolves paths WITH — agent/effects/fs.ts and agent/effects/scopes.ts both import it, so it runs BEFORE the capability exists. Converting it is a cycle and a contradiction at once: asking for authorization with the resolution that authorization is expressed in.',
  },
  {
    file: 'services/attachment-resolve.ts',
    klass: 'carrying-machinery',
    why: 'mechanic 5\'s resolution point: the gate loop resolves an attachment id to its recorded path BEFORE it mints the capability, with the same reader the handler uses. Same structural reason as path-resolve.ts; it was split out of transcription.ts so the executor need not pull the STT engines into every dispatch.',
  },

  // ── AGENT-TRIGGERED, PLATFORM-NAMED (17 statements / 12 files) ────────────
  {
    file: 'gateway/routes/update.ts',
    klass: 'agent-triggered',
    why: 'the self-update route: every path is the running install and the downloaded artifact, both named by the platform. An agent can ask for an update; it cannot say what gets written.',
  },
  {
    file: 'update/disk-preflight.ts',
    klass: 'agent-triggered',
    why: 'the update\'s disk-space pre-flight (SWEEP CORE-2 item 3, the owner\'s 2026-08-06 ask). Same class and same reasoning as gateway/routes/update.ts, which is its only caller: an agent can ask for an update, and this measures whether there is room for one. It is READ-ONLY — statfs on the data directory, statSync on the database and a walk of the installed platform tree — and every path is a platform literal (~/.dojo/data/dojo.db, ~/.dojo/platform) or is derived from it. The two parameters that can name a different path exist so a constrained-volume rehearsal and the unit suite can point it at a body of a known size; no agent-facing surface passes them. It writes nothing.',
  },
  {
    file: 'update-state.ts',
    klass: 'agent-triggered',
    why: 'the update state file, a fixed platform path. No argument reaches it.',
  },
  {
    file: 'prompt/agent-rename.ts',
    klass: 'agent-triggered',
    why: 'UX-REPAIR T50, the one rename door. It re-fills the STORED souls after a display name changes, and the file set is not an argument: it is `readdirSync(~/.dojo/prompts)` filtered to `SOUL.md` and `*-SOUL.md`, the same directory and the same naming rule `prompt/assembler.ts` already holds a platform-internal exclusion for (it is that file\'s `writeSoulFile` one layer up, and `update_agent` could already reach that through `writeAgentPromptSurface`). An agent CAN trigger it — `update_agent` renames a sub-agent — but the only thing an agent supplies is the new display NAME, which becomes file CONTENT through a word-boundary replacement of the old name. No argument forms a path, no path is joined from input, and no file outside the prompts directory is opened. Routing it through the facade would record an agent-facing fs site whose resource is a fixed platform directory, which is the thing the classification exists to stop being blurred.',
    residual: 'the stored soul an agent-triggered rename rewrites is a platform file, not a resource the agent named — the write is gate-DECIDED at the rename door and not facade-carried.',
  },
  {
    file: 'update/artifact-integrity.ts',
    klass: 'agent-triggered',
    why: 'streams the downloaded update artifact through sha256 before anything is rsynced over the running install. The path is the platform\'s own download location; routing it through an agent-facing broker would record an agent-facing fs site that does not exist (the $raise-no-restricted-imports-t6b record measured the three alternatives).',
  },
  {
    file: 'services/watchdog-refresh.ts',
    klass: 'agent-triggered',
    why: 'refreshes the watchdog bundle at a platform-literal path. Triggerable, never addressable.',
  },
  {
    file: 'services/tunnel.ts',
    klass: 'agent-triggered',
    why: 'the Cloudflare tunnel pidfile and its binary, both platform literals.',
  },
  {
    file: 'services/resource-monitor.ts',
    klass: 'agent-triggered',
    why: 'reads the platform\'s own resource counters from fixed paths.',
  },
  {
    file: 'vault/maintenance.ts',
    klass: 'agent-triggered',
    why: 'the encrypted vault\'s own files, at platform-named paths. The vault is the thing being protected; an agent naming its storage location is the shape this excludes.',
  },
  {
    file: 'voice/model-manager.ts',
    klass: 'agent-triggered',
    why: 'downloads and manages local STT/TTS model files under the platform model directory. The model NAME comes from a fixed catalogue, never from tool arguments.',
  },
  {
    file: 'voice/stt-service.ts',
    klass: 'agent-triggered',
    why: 'runs the local whisper/moonshine engines on the platform\'s own model files and its own scratch paths. transcribe_audio reaches it, and what it passes is a BUFFER, never a path.',
  },
  {
    file: 'voice/tts-service.ts',
    klass: 'agent-triggered',
    why: 'the local TTS engine\'s own model and cache files, platform-named.',
  },
  {
    file: 'voice/custom-voices.ts',
    klass: 'agent-triggered',
    why: 'the custom-voice store under the platform voice directory; entries are keyed by id, and the directory is a literal.',
  },

  // ── PLATFORM-INTERNAL (43 statements / 37 files) — no tool path at all ────
  { file: 'index.ts', klass: 'platform-internal', why: 'boot. It runs once before any agent exists.' },
  { file: 'logger.ts', klass: 'platform-internal', why: 'the log sink itself, at a platform path. Everything imports it, which is exactly why a graph walk cannot classify this tree.' },
  { file: 'config/loader.ts', klass: 'platform-internal', why: 'the platform config and secrets files, read at their own fixed paths.' },
  { file: 'db/connection.ts', klass: 'platform-internal', why: 'opens the platform database. One writer, one path, no argument.' },
  { file: 'db/migrations.ts', klass: 'platform-internal', why: 'the pre-migration online backup and the migration chain, both on the database\'s own path.' },
  { file: 'db/migration-backup.ts', klass: 'platform-internal', why: 'the pre-migration restore point, taken at boot on the database\'s OWN path (db.name) and written to the backups directory beside it. Nothing an agent can reach runs at that moment: this is called from runMigrations, before the port binds. The one path it touches that is not derived from the connection is the override FILE it checks and consumes in the same directory, which is the point of it -- it has to be readable on a box whose server will not start.' },
  { file: 'gateway/server.ts', klass: 'platform-internal', why: 'the HTTP server\'s own static serving, from platform directories.' },
  // 'gateway/routes/agents.ts' was here (platform-internal). T58 leg C deleted its last
  // restricted import: the route's file work now goes through prompt/agent-prompt-surface.ts,
  // and the orphaned `node:fs` import went with the T40 reader that used it. Entry removed
  // because the list must be EXACTLY the measured set -- a stale exclusion is a permission
  // nobody argued for. It comes back the day the file holds one again, with a fresh reason.
  { file: 'gateway/routes/config.ts', klass: 'platform-internal', why: 'the dashboard own config route: an HTTP handler reading and writing the platform config and model files at their fixed paths, driven by the settings UI. No tool dispatches it.' },
  { file: 'gateway/routes/migration.ts', klass: 'platform-internal', why: 'the dashboard\'s migration import/export route; the operator drives it from the UI, no tool dispatches it.' },
  { file: 'gateway/routes/services.ts', klass: 'platform-internal', why: 'the dashboard\'s own service-control route: an HTTP handler starting, stopping and inspecting platform services at platform-named paths, driven by the operator. No tool dispatches it.' },
  { file: 'gateway/routes/setup-deps.ts', klass: 'platform-internal', why: 'the dependency installer the setup UI runs.' },
  { file: 'gateway/routes/techniques.ts', klass: 'platform-internal', why: 'the dashboard technique upload route: the operator uploads a package over HTTP and this route unpacks it. It is the ONE production importer of techniques/share-import.ts, which is what SURFACE SPLIT 2 measured.' },
  { file: 'gateway/routes/upload.ts', klass: 'platform-internal', why: 'the dashboard\'s file upload/download route — the USER\'s uploads, over HTTP, not a tool call.' },
  { file: 'agent/v2/receipt.ts', klass: 'platform-internal', why: 'the engine\'s own receipt sink at a platform path.' },
  { file: 'memory/assembly-validation-sink.ts', klass: 'platform-internal', why: 'the assembler\'s own durable validation sink, a platform file.' },
  { file: 'prompt/assembler.ts', klass: 'platform-internal', why: 'reads the platform\'s own prompt-fragment files from the install tree.' },
  { file: 'providers/anthropic-sdk-auth.ts', klass: 'platform-internal', why: 'runs the provider CLI\'s own auth helper; no argument comes from a tool.' },
  { file: 'healer/healer-agent.ts', klass: 'platform-internal', why: 'the healer\'s own log and report files, at platform paths.' },
  { file: 'imaginer/imaginer-agent.ts', klass: 'platform-internal', why: 'the retired Imaginer\'s own files; unreachable from the toolbox even in the import graph, measured.' },
  { file: 'techniques/share-export.ts', klass: 'platform-internal', why: 'the technique EXPORT half, driven by the dashboard route.' },
  { file: 'techniques/share-import.ts', klass: 'platform-internal', why: 'the technique package IMPORT half after SURFACE SPLIT 2 (T8G): its one production importer is gateway/routes/techniques.ts, the dashboard upload route. The tool-facing setup surface left for techniques/import-setup.ts, which reaches disk through the facade.' },
  { file: 'tools/index-generator.ts', klass: 'platform-internal', why: 'the boot-time tool-doc GENERATOR after SURFACE SPLIT 1 (T8F): its one production caller is the boot step in index.ts, before any agent exists. The dispatch-time READER left for tools/tool-doc-read.ts, which holds no restricted import.' },
  { file: 'microsoft/office-packages.ts', klass: 'platform-internal', why: 'installs the office npm packages into the platform tree; the package set is a literal.' },
  { file: 'services/ensure-system-deps.ts', klass: 'platform-internal', why: 'the system dependency installer; unreachable from the toolbox even in the import graph, measured.' },
  { file: 'screen-share/manager.ts', klass: 'platform-internal', why: 'drives the macOS screen-sharing service with fixed system commands.' },
  { file: 'twilio/sms-inbound.ts', klass: 'platform-internal', why: 'the inbound SMS webhook writing its own media cache at a platform path.' },
  { file: 'plaud/auth.ts', klass: 'platform-internal', why: 'the Plaud auth helper process, a platform-named binary.' },
  { file: 'voice/smart-turn.ts', klass: 'platform-internal', why: 'the turn-detection model files, platform-named.' },
  { file: 'voice/voice-assets.ts', klass: 'platform-internal', why: 'the bundled voice assets in the install tree.' },
  { file: 'migration/checks.ts', klass: 'platform-internal', why: 'the migration tool\'s own preflight checks.' },
  { file: 'migration/export.ts', klass: 'platform-internal', why: 'the machine-to-machine migration EXPORT writer. The migration tool is an operator-run utility that packages one install for another box; it runs outside the server tool surface entirely and its paths are the install tree and the export bundle.' },
  { file: 'migration/fs-copy.ts', klass: 'platform-internal', why: 'the migration tree copier: it walks the install tree and the export bundle, both platform-named, for the operator-run migration utility. No tool reaches it.' },
  { file: 'migration/import.ts', klass: 'platform-internal', why: 'the machine-to-machine migration IMPORT reader: it unpacks an export bundle onto a fresh install for the operator. Its paths are the bundle and the install tree, never an argument.' },
  { file: 'migration/manifest.ts', klass: 'platform-internal', why: 'the migration manifest builder: it shells out to enumerate and checksum the install tree for the operator-run migration utility. The commands and the paths are both literals.' },
  { file: 'migration/path-migration.ts', klass: 'platform-internal', why: 'the migration path rewriter: it rewrites absolute paths recorded on the old box to the new box install root. Operator-run, outside the tool surface, on the install tree alone.' },
  { file: 'migration/step-classify.ts', klass: 'platform-internal', why: 'the migration step classifier: it inspects the source install and the environment to decide which migration steps apply. Operator-run, on platform-named paths and fixed commands.' },

  // ── HONEST LABEL (16 statements / 13 files) ──────────────────────────────
  // ✅ OWNER DECIDED 2026-08-03: "Earlier permission is enough." Nothing here
  // converts and nothing here is refused. Each entry states its RESIDUAL.

  // (a) The five part-4 files — agent-influenced resource, platform-timed run.
  {
    file: 'agent/runtime.ts',
    klass: 'honest-label',
    why: 'PART 4. The agent runtime\'s own working files, written on the platform\'s timing rather than inside a dispatch the agent opened.',
    residual: 'a resource an earlier tool call influenced is written when the platform acts, so it is gate-DECIDED and not facade-carried.',
  },
  {
    file: 'agent/image-prep.ts',
    klass: 'honest-label',
    why: 'PART 4. Image preparation runs on the platform\'s own ingest timing, outside the dispatch that produced the image.',
    residual: 'the image path came from a gate-DECIDED call; the prep read is not facade-carried.',
  },
  {
    file: 'services/video-job-poller.ts',
    klass: 'honest-label',
    why: 'PART 4. The video poller is started at boot and fires on its own timer; a converted site there would hold no capability and refuse working behaviour, and a new refusal is never a worker\'s to invent (P5-R5).',
    residual: 'the asset the poller fetches was named by a gate-DECIDED submit call; the fetch itself is not facade-carried.',
  },
  {
    file: 'techniques/store.ts',
    klass: 'honest-label',
    why: 'PART 4. The technique store is read and written from both dispatch and platform-timed paths (boot scan, trainer cycle).',
    residual: 'technique files an agent named earlier are touched on platform timing without a second check.',
  },
  {
    file: 'services/imessage-bridge.ts',
    klass: 'honest-label',
    why: 'PART 4. The iMessage bridge runs as an inbound listener as well as an outbound send, and its attachment staging happens on the bridge\'s own timing.',
    residual: 'an attachment an agent named in a send is staged outside that call\'s context.',
  },

  // (b) The seven ADDENDUM 3(2) files — one function serves both populations,
  //     so there is no half to move and a split would be a rewrite.
  {
    file: 'agent/system-control.ts',
    klass: 'honest-label',
    why: 'ADDENDUM 3(2), measured at T8F: all 13 fs sites sit in functions the dashboard route mirrors 1:1, so every one serves both the tool layer and the route. Duplicating a body to force a split is REFUSED (a rewrite wearing a relocation\'s clothes); a partial in-file conversion is REFUSED (reach shrinks while the count stands still).',
    residual: 'dispatch-context reach through a dual-service function stays gate-DECIDED but not facade-carried.',
  },
  {
    file: 'services/canvas-html.ts',
    klass: 'honest-label',
    why: 'ADDENDUM 3(2), measured at T8F: all 3 fs sites are in one export with exactly two callers, one of them the tool layer and one the platform.',
    residual: 'dispatch-context reach through a dual-service function stays gate-DECIDED but not facade-carried.',
  },
  {
    file: 'services/office-render.ts',
    klass: 'honest-label',
    why: 'ADDENDUM 3(2), measured at T8F: both fs sites are inside a function serving both populations.',
    residual: 'dispatch-context reach through a dual-service function stays gate-DECIDED but not facade-carried.',
  },
  {
    file: 'techniques/versioning.ts',
    klass: 'honest-label',
    why: 'ADDENDUM 3(2), measured at T8F: the version writer serves the technique tools and the platform\'s own maintenance path out of one body.',
    residual: 'dispatch-context reach through a dual-service function stays gate-DECIDED but not facade-carried.',
  },
  {
    file: 'techniques/dependencies.ts',
    klass: 'honest-label',
    why: 'ADDENDUM 3(2), measured at T8F: the dependency installer is reached from the technique tools and from the platform install path through the same function.',
    residual: 'dispatch-context reach through a dual-service function stays gate-DECIDED but not facade-carried.',
  },
  {
    file: 'plaud/client.ts',
    klass: 'honest-label',
    why: 'ADDENDUM 3(2), measured at T8F: the Plaud client\'s fs use sits in a function reached by both the tool verbs and the platform sync.',
    residual: 'dispatch-context reach through a dual-service function stays gate-DECIDED but not facade-carried; the npx spawn is a fixed program the argv of which the client builds.',
  },
  {
    file: 'services/video-generation.ts',
    klass: 'honest-label',
    why: 'ADDENDUM 3(2)\'s SEVENTH member, re-measured at T8G: ensureGeneratedDir is called by BOTH submitVideoJob (dispatch) and fetchVideoAsset (the boot-resumed poller), so one function serves both populations and there is no half to move. All three forced alternatives are refused by name.',
    residual: 'dispatch-context reach through a dual-service function stays gate-DECIDED but not facade-carried.',
  },

  // (c) The canvas watch pair — ADDENDUM 3(3), the 3-way split's own residual.
  {
    file: 'agent/canvas-watch.ts',
    klass: 'honest-label',
    why: 'ADDENDUM 3(3). The 3-way split of agent/canvas-view.ts left this module holding exactly the two watch calls and nothing else, deliberately: the smaller the honest-label residual, the more the excluded list means. The watched path is set from BOTH populations (a tool opening a canvas, and the dashboard\'s hydrate-on-mount through GET /api/canvas) and the callback fires from a polling timer OUTSIDE any dispatch.',
    residual: 'the watched path was chosen inside a gate-DECIDED call and is not facade-carried when the timer fires.',
  },

  // ── NAMED EXCLUSION, measured this task ──────────────────────────────────
  {
    file: 'services/public-share.ts',
    klass: 'named-exclusion',
    why: 'RULING P5-R15 ADDENDUM 2 authorized an ATTEMPT at content-derived resolution and sanctioned this outcome; T8H measured it and the attempt does not survive contact, for two independent reasons. (1) THE ENUMERATION CANNOT BE ONE RESOLUTION POINT. Which assets exist is decided by five sequential String.replace passes, each running over the output of the previous, and the rewrite IS the enumeration; a gate-loop scan would be a SECOND traversal of a different text — two answers to one question, which is the two-chances-to-disagree disease this project deletes. Restructuring the handler to enumerate first and rewrite from the enumeration is a rewrite of the mechanism, which a relocation may never be. (2) THE RESOLUTION WOULD RUN AHEAD OF THE DENY THAT PROTECTS IT. Content-derived resolution means READING the shared file\'s bytes at gate-loop time, and share_publicly\'s sensitive-path refusal lives in the HANDLER (sharePathGuard), not in the gate loop — so the platform would read and scan a denied .html (the deny rows include whole directories: ~/.ssh, ~/.config/gcloud, the dojo secret store) before the refusal that exists to stop it. Making the resolver ask the deny first is the facade growing a permission predicate, refused outright. THE PARTIAL WAS ALSO REFUSED: declaring only the ~/.dojo/out write tree and converting only those sites is a partial in-file conversion — reach shrinks while the count stands still (ADDENDUM 3(2)).',
    residual: 'the deliberate absolute/file:// asset capability and the per-asset copies stay gate-DECIDED and are not facade-carried; the two live sensitive-path denials at this site are untouched and byte-identical.',
  },
];

/** Just the file paths, for the eslint override block. */
export const EFFECT_IMPORT_EXCLUDED_FILES = EFFECT_IMPORT_EXCLUSIONS.map((e) => e.file);
