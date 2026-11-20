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
// ── THE REFUSALS THAT SHAPED IT (RULING P5-R12, restated because they bind) ──
// Never move a site between classes to make the count fall. Never route
// platform-internal machinery through agent-facing brokers. Both were live
// temptations here and both were refused; the per-file `why` of every honest
// label says what was measured instead.
//
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

  // ── AGENT-TRIGGERED, PLATFORM-NAMED (19 statements / 14 files) ────────────
  // The two counts in this section header and the next were RE-DERIVED at DOJO-REPORT T2
  // (2026-09-23), not incremented: both had drifted one file behind the list they describe.
  // `node_modules/.bin/eslint packages/server/src --no-inline-config -f json`, grouping the
  // `no-restricted-imports` messages by the class each file is declared under.
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
    file: 'update/copy-tree.ts',
    klass: 'agent-triggered',
    why: 'the dependency-tree copy, split out of update/install-tree.ts (same class, same reasoning): it runs `cp` on the live node_modules and the staged tree, both platform paths derived from ~/.dojo/platform. No argument an agent supplies forms a path or a command.',
  },
  {
    file: 'update/leftovers.ts',
    klass: 'agent-triggered',
    why: 'the boot sweep of what a killed update left behind, split out of gateway/routes/update.ts (same class, same reasoning): it lists ~/.dojo and removes platform.staging-* work dirs of dead installers and update-state.json temp files of dead writers. Every name is a platform pattern; nothing an agent supplies is read.',
  },
  {
    file: 'update/install-tree.ts',
    klass: 'agent-triggered',
    why: 'the ONE platform installer (v3.4 t197), which the self-update and rollback routes and deploy/install.sh all call. Same class and reasoning as gateway/routes/update.ts, out of which it was moved: an agent can ask for an update, and every path here is a platform literal (~/.dojo/platform, its platform.backup-*/platform.staging-* siblings, the rollback.lock) or the release the platform downloaded. It clones dependencies, runs npm in the staged tree, loads the database module as a check, and renames trees. No argument an agent supplies forms a path or a command.',
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
  {
    file: 'agent/brokers/sudo-probe.ts',
    klass: 'agent-triggered',
    why: 'SUDO POLICY v3.2.2 (owner ruling 2026-09-26). A tool call makes it run, and NOT ONE CHARACTER '
      + 'OF WHAT IT EXECUTES COMES FROM THE AGENT: the probe is the compile-time constant '
      + '`execFile(\'sudo\', [\'-n\', \'true\'])` — no interpolation, no argument, nothing read from the '
      + 'command being authorized. It asks sudo itself one question ("would you prompt for a password?") '
      + 'and `true` is a no-op, deliberately, because probing with the REAL command would RUN it when the '
      + 'answer is yes. ROUTING IT THROUGH `agent/effects/proc.ts` WAS TRIED AND IS WRONG, for RULING '
      + 'P5-R12\'s stated reason: `spawnAuthorized` calls `requireAuthorized({op:\'proc\', '
      + 'program:\'sudo\'})`, and the per-call capability the gate loop resolved names the program the '
      + 'AGENT asked for (`/bin/zsh`, or its argv[0]) — never `sudo`. The call would either fail on every '
      + 'box or force a capability for a program no agent requested, recording an agent-facing proc site '
      + 'that does not exist. RESIDUAL, stated: this spawns one short-lived process per sudo-shaped '
      + 'command on a box whose sudo prompts, bounded by a 1.5s timeout and cached per process after the '
      + 'first answer. It reads no path and writes nothing — a clause in '
      + '`sudo-is-a-policy-not-a-wall.test.ts` holds that no module in the sudo family writes a file.',
  },
  {
    file: 'report/bundle.ts',
    klass: 'agent-triggered',
    why: 'DOJO-REPORT T2. The local evidence bundle at `~/.dojo/reports/<id>/bundle.json`, the receipts convention. `dojo_report` makes it run, and NOT ONE BYTE OF THE DESTINATION COMES FROM THE AGENT: the directory is a platform literal, `<id>` is the uuid `report/store.ts` minted, and both path segments are refused unless they match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (plus one extension for a file name) — a regex that cannot express `..` or a separator, so a traversal is not a thing this module can be talked into. The CONTENT is agent-adjacent and is handled where content is handled: the whole document goes through `redactHandedCredentials` before it touches the disk, and a document over `REPORT_BUNDLE_MAX_BYTES` is replaced by a truncation marker rather than written as a prefix. Routing it through `agent/effects/fs.ts` was refused for RULING P5-R12\'s stated reason: the capability would name a path the agent never chose, recording an agent-facing fs site that does not exist.',
  },

  // ── PLATFORM-INTERNAL (42 statements / 36 files) — no tool path at all ────
  { file: 'index.ts', klass: 'platform-internal', why: 'boot. It runs once before any agent exists.' },
  { file: 'logger.ts', klass: 'platform-internal', why: 'the log sink itself, at a platform path. Everything imports it, which is exactly why a graph walk cannot classify this tree.' },
  { file: 'log-rotation.ts', klass: 'platform-internal', why: 'the log sink\'s rotation, split out of logger.ts by T74b so the keep policy and its two guards could be stated and tested. Same file, same platform path, same reach as logger.ts: it is handed the live log path by logger.ts and touches only that file and its one backup.' },
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
  { file: 'services/ollama-host.ts', klass: 'platform-internal', why: 'the fixed-argument Mac commands (lsof, pgrep, launchctl, open, brew, sw_vers, ollama serve) the one Ollama upkeep (services/ollama-upkeep.ts) runs from setup, a start, Repair and the health check; no tool dispatches it, and a test run reaches no real command.' },
  { file: 'gateway/routes/automation-probe.ts', klass: 'platform-internal', why: 'the setup UI\'s Automation permission check (t115, owner ruling 2026-10-06), factored out of gateway/routes/setup-deps.ts — the entry directly above, same class and same reasoning — only because that file sits at its size ratchet with no headroom. It spawns ONE process: /usr/bin/osascript by absolute path, with no shell, carrying a module-constant AppleScript (`tell application "Messages" to get name`) that nothing is interpolated into. There is no parameter, agent-facing or otherwise, that can name a different program or a different script, and the expression is a read of a read-only property, so it cannot write anything even in the app it drives. Reached only by GET /api/setup/permissions/check, the dashboard\'s own permissions screen; no tool dispatches it.' },
  { file: 'gateway/routes/techniques.ts', klass: 'platform-internal', why: 'the dashboard technique upload route: the operator uploads a package over HTTP and this route unpacks it. It is the ONE production importer of techniques/share-import.ts, which is what SURFACE SPLIT 2 measured.' },
  { file: 'gateway/routes/upload.ts', klass: 'platform-internal', why: 'the dashboard\'s file upload/download route — the USER\'s uploads, over HTTP, not a tool call.' },
  { file: 'agent/v2/receipt.ts', klass: 'platform-internal', why: 'the engine\'s own receipt sink at a platform path.' },
  { file: 'memory/assembly-validation-sink.ts', klass: 'platform-internal', why: 'the assembler\'s own durable validation sink, a platform file.' },
  { file: 'prompt/assembler.ts', klass: 'platform-internal', why: 'reads the platform\'s own prompt-fragment files from the install tree.' },
  { file: 'prompt/user-profile.ts', klass: 'platform-internal', why: 'the ONE source of truth for `~/.dojo/prompts/USER.md` (owner ruling #11, t111-A3), split out of prompt/assembler.ts above, which is on this list for the same reason and was doing this work inline before. NOT ONE BYTE OF THE PATH COMES FROM AN AGENT: `userProfilePath()` is `homeDir()` joined with three platform literals, there is no parameter in it, and the only argument any writer takes is the profile TEXT. Its readers are the assembler slot and the two dashboard routes (the Settings edit door and the OOBE form); no tool reaches it, and nothing an agent says can name a different file. Routing it through `agent/effects/fs.ts` was refused for the reason RULING P5-R12 gives: the capability would record an agent-facing fs site that does not exist.' },
  { file: 'providers/anthropic-sdk-auth.ts', klass: 'platform-internal', why: 'runs the provider CLI\'s own auth helper; no argument comes from a tool.' },
  { file: 'healer/healer-agent.ts', klass: 'platform-internal', why: 'the healer\'s own log and report files, at platform paths.' },
  { file: 'techniques/share-disk.ts', klass: 'platform-internal', why: 'the disk work of the technique package export and import (walk and read a technique folder, unpack a package, make and remove the folder an import made). Its only importers are techniques/share-import.ts and techniques/share-export.ts, both reached only from gateway/routes/techniques.ts, the dashboard route; no tool dispatches it.' },
  { file: 'boot-stamp.ts', klass: 'platform-internal', why: 'the boot-time LOADED-CODE stamp (infra lane, ce91ab13): written once at boot before any agent exists, exactly the index-generator shape; node:fs writes the stamp beside the DB, node:child_process reads only this process\'s own start facts. The kit probe READS the stamp; nothing agent-reachable imports this module (the wiring walk holds the edge).' },
  { file: 'tools/index-generator.ts', klass: 'platform-internal', why: 'the boot-time tool-doc GENERATOR after SURFACE SPLIT 1 (T8F): its one production caller is the boot step in index.ts, before any agent exists. The dispatch-time READER left for tools/tool-doc-read.ts, which holds no restricted import.' },
  { file: 'microsoft/office-packages.ts', klass: 'platform-internal', why: 'installs the office npm packages into the platform tree; the package set is a literal.' },
  { file: 'services/keep-awake.ts', klass: 'platform-internal', why: 'the boot starts /usr/bin/caffeinate once, with fixed arguments and the server\'s own pid; no tool reaches it.' },
  { file: 'services/ensure-system-deps.ts', klass: 'platform-internal', why: 'the system dependency installer; unreachable from the toolbox even in the import graph, measured.' },
  { file: 'screen-share/manager.ts', klass: 'platform-internal', why: 'drives the macOS screen-sharing service with fixed system commands.' },
  { file: 'twilio/sms-inbound.ts', klass: 'platform-internal', why: 'the inbound SMS webhook writing its own media cache at a platform path.' },
  { file: 'plaud/auth.ts', klass: 'platform-internal', why: 'the Plaud auth helper process, a platform-named binary.' },
  { file: 'voice/smart-turn.ts', klass: 'platform-internal', why: 'the turn-detection model files, platform-named.' },
  { file: 'voice/voice-assets.ts', klass: 'platform-internal', why: 'the bundled voice assets in the install tree.' },
  { file: 'migration/checks.ts', klass: 'platform-internal', why: 'the migration tool\'s own preflight checks.' },
  { file: 'agent/effects/toolbox-ledger.ts', klass: 'platform-internal', why: 'the boot-time ledger of process groups the toolbox started: reads and writes ONE platform-literal file under the Dojo home and signals only the groups it recorded, each re-checked against the process identity (v3.5 t29-p6). No path or command comes from an agent.' },
  { file: 'agent/background-commands.ts', klass: 'platform-internal', why: 'the record of commands handed to the background (v3.5 field fix 3, re-review 3 to 5). The record itself is the `background_commands` table (migration 213) and holds no fs work. The one `node:fs` use is `legacyRows()`: at boot, `tellAgentsOfCommandsCutByRestart` (whose one production caller is the boot step in index.ts, before any agent exists) reads the file the build before kept, `dojoDir(\'data\', \'background-commands.json\')`, a platform literal with no parameter, tells each agent its notice, and removes that one file once every notice is saved. The tool path into this module (agent/tools/person-first.ts, through recordHandOff, settleHandOff and endHandOff) and the ledger path (work/ledger-store.ts) are database writes only and never reach the fs call; nothing an agent says can name a different file. Routing it through `agent/effects/fs.ts` was refused for the reason RULING P5-R12 gives: there is no tool call at boot, so the capability would record an agent-facing fs site that does not exist.' },
  { file: 'process-identity.ts', klass: 'platform-internal', why: 'asks `ps` for the start time and command of one integer process id, or for every command line (proof-fix T, to find the port of the local model runner): a fixed program, argv form, no shell, no agent input (v3.5 t29-p6).' },
  { file: 'migration/export.ts', klass: 'platform-internal', why: 'the machine-to-machine migration EXPORT writer. The migration tool is an operator-run utility that packages one install for another box; it runs outside the server tool surface entirely and its paths are the install tree and the export bundle.' },
  { file: 'migration/fs-copy.ts', klass: 'platform-internal', why: 'the migration tree copier: it walks the install tree and the export bundle, both platform-named, for the operator-run migration utility. No tool reaches it.' },
  { file: 'migration/import.ts', klass: 'platform-internal', why: 'the machine-to-machine migration IMPORT reader: it unpacks an export bundle onto a fresh install for the operator. Its paths are the bundle and the install tree, never an argument.' },
  { file: 'migration/manifest.ts', klass: 'platform-internal', why: 'the migration manifest builder: it shells out to enumerate and checksum the install tree for the operator-run migration utility. The commands and the paths are both literals.' },
  { file: 'migration/path-migration-db.ts', klass: 'platform-internal', why: 'the database step of the migration path rewriter, split out of migration/path-migration.ts (same class, same reasoning): it opens the imported database file under the install tree and rewrites old-box home paths in one transaction. Operator-run, outside the tool surface.' },
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
    file: 'tools/file-set-count.ts',
    klass: 'honest-label',
    why: 'v3.5 field fix 3 (audit #5): the file-set measure is counted by the engine at the end of a turn and at a close, outside any tool call\'s capability. Before every count the measure is checked with file_list\'s own gates for the agent (agent/tools/cat/measure-door.ts refusalFor), so the walk only reads a tree the agent\'s read grant covers.',
    residual: 'the walk itself is not facade-carried; it reads directory listings only (names and types, never contents) under the path the gates just allowed.',
  },
  {
    file: 'work/done/file-facts.ts',
    klass: 'honest-label',
    why: 'A file proof item is read when the engine checks a hand-in, outside any tool call\'s capability. Before the read the worker\'s own file_read permission is checked for that exact path (agent/permissions.ts checkPermission), so only a file the worker may read is hashed.',
    residual: 'the read itself is not facade-carried; it stats and hashes one path the gate has just allowed, and keeps at most an 8 KB excerpt.',
  },
  {
    file: 'agent/image-prep.ts',
    klass: 'honest-label',
    why: 'PART 4. Image preparation runs on the platform\'s own ingest timing, outside the dispatch that produced the image.',
    residual: 'the image path came from a gate-DECIDED call; the prep read is not facade-carried.',
  },
  {
    file: 'services/media-delivery.ts',
    klass: 'honest-label',
    why: 'PART 4. The one delivery of a finished media file runs after the tool call that started its job, and for a video from the poller started at boot; a converted site there would hold no capability and refuse working behaviour (P5-R5).',
    residual: 'the file it copies was written by a gate-DECIDED generation call into the platform generated folder; the copy into the agent uploads folder and the public link are not facade-carried.',
  },
  {
    file: 'techniques/technique-folder.ts',
    klass: 'honest-label',
    why: 'The technique folder\'s "resolve inside this folder" check, consulted by the tool-facing supporting-file writes (techniques/tools.ts, techniques/store.ts) and by the dashboard import and export. The check only reads the disk.',
    residual: 'the check only reads; the write it guards is made by its caller, which is trusted to use the returned path.',
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
  {
    file: 'services/imessage-run.ts',
    klass: 'honest-label',
    why: 'v3.5 E19b: the iMessage bridge\'s process calls MOVED OUT of services/imessage-bridge.ts (the entry above, which now holds no child_process) when the sends became async and bound to the owner\'s Stop. Its sends now run through the one Stop-bound runner (agent/stop-bound-run.ts); what it still runs itself is platform-literal: `which`/`imsg --help` for the runnability probe and macOS `sips` for an inbound HEIC photo. An agent\'s own send (imessage_send) binds the child to that agent\'s Stop through the runner. Routing it through agent/effects/proc.ts is refused for RULING P5-R12\'s reason: the per-call capability names the program the agent asked for, never these.',
    residual: 'the text, the recipient (allowlist-checked by the tool) and an attachment path the agent named reach imsg/osascript as arguments, gate-DECIDED by the tool but not facade-carried; the platform sends (owner notices, the auto-route) run with no call context at all.',
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
    file: 'agent/stop-bound-run.ts',
    klass: 'honest-label',
    why: 'v3.5 E19 + E19b: THE ONE RUNNER for a platform program the owner\'s Stop can cut. The screen-control tools (agent/system-control.ts, the entry above: cliclick, screencapture, osascript, and `which` for the cliclick probe) and the iMessage sends (services/imessage-run.ts: imsg, osascript) each had a near-copy; both now call this one. It runs ONLY the program its caller names from those fixed lists, argv form, no shell, and binds each child to the Stop through agent/effects/proc-tree.ts. Routing it through agent/effects/proc.ts is refused for RULING P5-R12\'s reason: the per-call capability names the program the agent asked for, never these.',
    residual: 'dispatch-context reach through a dual-service function stays gate-DECIDED but not facade-carried, as for agent/system-control.ts; a platform send runs with no call context at all.',
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
