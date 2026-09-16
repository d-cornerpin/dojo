# W80 — Unexplained dojo-server restarts on the dev box

**Verdict up front.** There are no unexplained restarts. Every dev-box restart in the last
five days is a `tsx watch` file-change restart, and the log line names the file that
triggered it. There was **no crash, no OOM, no SIGKILL, no watchdog, and no launchd job** on
this box. The "double-boot at 2026-09-16T07:03:47Z" is **not a boot at all** — it is the
vitest suite writing into the owner's live `~/.dojo/logs/dojo.log`, and in doing so it
**destroyed the server's real log history**. That log-destruction is the named defect below.

For production: a stable user box restarts on **update-apply, uncaught exception, watchdog
kickstart after a ~10-minute outage, the dashboard restart button, and reboot/login**. None
of these is a daily event on a healthy box. W79's rehydration fix is a **rare-event fix per
box, but a certain-event fix per release** — see §6.

---

## 1. Every server boot in the last 5 days

**The clean boot signature is not the migration runner.** `runMigrations()` is called by 126
test files as well as by the server, so migration lines are ambiguous (§3). The unambiguous
signature is the `tsx watch` supervisor's own stdout:

- File: `/Users/dcliff9/.dojo/logs/devserver-w56.log`
- Supervisor: pid **13224** (`node ../../node_modules/.bin/tsx watch src/index.ts`), started
  **Sun Aug 30 23:56:01 2026**, still alive. It has never restarted; only its child has.
- Current child: pid **72320**, started **Tue Sep 15 23:59:29 2026 PDT**.

The log carries times but no dates. Anchoring the last line to pid 72320's real start time
(`23:59:29 PM` ⇄ `Tue Sep 15 23:59:29`) and walking backwards through the wrap points dates
the whole file: it spans **2026-09-11 06:52:41 → 2026-09-15 23:59:29** — exactly the last
five days, 379 `[tsx]` lines, of which **370 are restart/rerun events** and 9 are kill
notices attached to them.

| Date | Restarts |
|---|---|
| 2026-09-11 | 68 |
| 2026-09-12 | 75 |
| 2026-09-13 | 17 |
| 2026-09-14 | 194 |
| 2026-09-15 | 16 |
| **Total** | **370** |

That is ~74/day — a normal dev-edit rate, not a pathology.

Top trigger files: `memory/assembler.ts` (32), `agent/model.ts` (23),
`gateway/routes/dev.ts` (22 change + 20 unlink + 1 add), `agent/access/authorize.ts` (14),
`gateway/routes/config.ts` (13), `agent/tools/cat/agents.ts` (12).

## 2. Per-boot cause

**370/370 = tsx-watch file-change.** The breakdown by *who* changed the file:

- **323 restarts — a human/agent editing source.** Ordinary development.
- **47 restarts — the dojo-test-kit server-instruments harness**, i.e. *nobody was editing
  the tree*. This is the owner's observation, explained. The harness installs
  `packages/server/src/gateway/routes/dev.ts` (per `DOJO-ISSUES-LOG.md:176`,
  `manifest.mjs NEW_FILES:10` maps `files/dev.ts` → that path) and patches
  `services/imessage-bridge.ts` (its docblock at `imessage-bridge.ts:962` names "the
  dev-harness probe (gateway/routes/dev.ts)"). **Install restarts the server; uninstall
  restarts it again.** The uninstall is visibly atomic — both files fire in the same second:

  ```
  2026-09-15 23:55:08  change in ./src/services/imessage-bridge.ts Restarting...
  2026-09-15 23:55:08  unlink in ./src/gateway/routes/dev.ts Process hasn't exited. Killing process...
  ```

  Because the harness runs *against a live session*, these restarts land in the middle of
  the owner's DS4 traffic. That is the observed "restarts with nobody touching the tree."

**Crash classes: zero.**
- `grep -c "Uncaught exception"` → 0 in `dojo.log`, `dojo.log.1`, `devserver-w56.log`.
- `grep -c "Unhandled promise rejection"` → 0.
- `heap out of memory` / `FATAL ERROR` / `Allocation failed` → 0 occurrences.
- macOS crash reporter: `~/Library/Logs/DiagnosticReports/` contains **no** node/tsx reports.
- Current child RSS after ~1h of heavy DS4 traffic: **~488 MB**. Nowhere near a heap limit.

The only failed boots are **13 `SyntaxError` blocks** where tsx started a child against a
half-saved edit and it died before listening — e.g. 2026-09-14 23:26, repeatedly:
`SyntaxError: The requested module '../access/read.js' does not provide an export named
'mayTouchCredential'`. These are edit-race artifacts, not runtime crashes, and the next
file-save fixed each one. Nine `Process didn't exit in 5s. Force killing...` lines are tsx
SIGKILLing a child that ignored SIGTERM — the *outbound* half of a restart, not a cause.

## 3. The 07:03:47Z "double-boot" — explained, and it is not a boot

`2026-09-16T07:03:47Z` = `2026-09-16 00:03:47 PDT`. The tsx log shows **no restart between
23:59:29 and now**; pid 72320 has been up continuously (`etime 01:08+` at the time of
investigation), and `cost_records` show it serving live DS4 turns at 07:53–08:09Z on the
same process. **The server did not restart.**

What actually happened at 00:03 local was a **vitest run against the owner's real HOME.**

Evidence:

1. **Volume.** `"Running database migrations"` appears **369 times** across `dojo.log` +
   `dojo.log.1`, all inside a **14-second window** (07:03:34 → 07:03:48). Peak 41/second.
   No supervisor restarts a server 26 times a second.
2. **Process count.** `"Database connection established"` appears **29 times** in the same
   window. `getDb()` caches per process (`db/connection.ts:14`), so 29 connections = **29
   distinct processes** — a vitest worker pool, not a server.
3. **Fake timers.** 2,698 log lines carry the timestamp `2026-08-30T18:00:00.000Z`, frozen
   to the millisecond. That is `memory/__tests__/the-prefix-holds-still.test.ts:96`
   (`const DAY_ONE = Date.parse('2026-08-30T18:00:00Z')`). Only a test can emit that.
4. **Non-monotonic order.** Line 40001 of `dojo.log.1` is at `07:03:38.908` and line 60001
   at `07:03:38.759` — concurrent `fs.appendFile` from many processes interleaving.
5. **Artifacts on disk.** `~/.dojo/out/` contains **30 directories named
   `20260916-000349-*`**, all created at 00:03:49 local, each holding `page.html` + `logo.png`.
   `OUT_DIR` is defined at `services/public-share.ts:27` as `~/.dojo/out`. Those are
   public-share test fixtures written into the owner's real home directory.

So the "two migration-runner boot sequences ~1 second apart" are simply **two of 369** test
invocations that happened to land either side of a log rotation. The apparent split — the
tail of one run in `dojo.log.1` ending at migration 148 at `07:03:41.338`, and a fresh run
starting from migration 002 in `dojo.log` at `07:03:41.354` — is the rotation itself
bisecting the storm, not a process dying and retrying.

## 4. Correlation with the owner's DS4 sessions

Heavy load is **not** crashing the process.

- `cost_records` confirm the traffic: prompts of **27,754 / 35,595 / 36,743 tokens** at
  07:53–08:09Z, 115 records in the preceding 6 hours.
- All of that traffic was served by **pid 72320**, which never restarted.
- No OOM, no heap growth to a limit, RSS ~488 MB.

The correlation the owner felt is real but has a different mechanism: the **test harness**
runs *during* his sessions (§2), and each install/uninstall bounces the server. Load is the
correlate of harness activity, not the cause of a crash.

## 5. Watchdog / launchd on the DEV box

**None.** `launchctl list | grep -iE 'dojo|node|tsx'` → empty. `~/Library/LaunchAgents/`
holds only Adobe/Google/Microsoft/Topaz plists. `/Library/LaunchAgents` and
`/Library/LaunchDaemons` have no dojo or node entries. `deploy/launchd/` in the repo contains
only a README — the plists are generated at install time and this box was never installed.

The dev box's only supervisor is `tsx watch` (pid 13224), which restarts **solely** on file
change. Nothing auto-restarts on exit here.

## 6. THE PRODUCTION QUESTION — how often does a stable box restart?

A user box is installed by `deploy/install.sh`, which generates two launchd agents
(`install.sh:230-320`):

| Job | KeepAlive | ThrottleInterval | RunAtLoad |
|---|---|---|---|
| `com.dojo.platform` → `packages/server/dist/index.js` | `true` | 10s | `true` |
| `com.dojo.watchdog` → `~/.dojo/watchdog/dist/index.js` | `true` | 30s | `true` |

`KeepAlive` is **`true`, not `SuccessfulExit`** — launchd revives the platform on *any*
exit, clean or not, after ≥10s. So every exit below is a restart.

**The complete restart inventory for a stable box:**

1. **Update apply — certain, once per release the owner accepts.**
   `gateway/routes/update.ts:777` → `markBootingNew(); setTimeout(() => process.exit(0), 1000)`
   with the comment `// launchd will restart us`. Note the update check is *not* a restart:
   `index.ts:904-908` starts a checker that "refreshes a DB cache of the latest release once
   a day (model-free) … the owner decides whether to check on a schedule." Nothing applies
   automatically. So: **one restart per accepted release, not nightly.**

2. **Uncaught exception — rate = the codebase's crash rate.**
   `index.ts:100-110` logs the error, kills the tunnel child, then
   `setTimeout(() => process.exit(1), 100)`. launchd revives in ~10s. Importantly,
   `unhandledRejection` (`index.ts:112-118`) **only logs — it does not exit**, which removes
   the single largest accidental-restart class in a Node server. Observed rate on this box
   over the 5-day window: **zero** uncaught exceptions.

3. **Watchdog kickstart — only after a genuine ~10-minute outage.**
   `watchdog/src/index.ts`: `CHECK_INTERVAL_MS = 120_000` (2 min), health fetch
   `AbortSignal.timeout(3000)`, `MAX_FAILURES_BEFORE_RESTART = 5`. It fires
   `launchctl kickstart -k gui/$(id -u)/com.dojo.platform` only after **5 consecutive failed
   checks ≈ 10 minutes** of the platform not answering `/api/health` within 3s. A heavy DS4
   turn cannot produce that: it would need the event loop blocked across five separate
   probes spanning ten minutes. The watchdog also explicitly *holds* the kickstart during a
   self-update migration boot (`index.ts:1071-1077`). **This is a recovery path, not a
   routine cycle.**

4. **The watchdog does not cycle itself.** It is a long-lived `setInterval` daemon
   (`index.ts:1181-1185`); it exits only on crash, and its own `KeepAlive` covers that.
   It restarts the *platform*, never on a timer.

5. **Dashboard restart button — user-initiated.** `gateway/routes/system.ts:297-313`
   (`POST /system/restart`) exits after 300ms. Not agent-reachable: the only `restart` action
   in the tool surface is `session.ts:42` / `definitions.ts:1445`, which restarts the
   **tunnel**, not the server.

6. **Reboot / logout / login / OS update.** `RunAtLoad=true` means every macOS restart is a
   dojo boot. On a typical Mac this is roughly **weekly-to-monthly**.

7. **No nightly restart exists.** The daily timers in `index.ts` — `cleanupOldUploads`
   (`:1090`), the nightly vault dreaming cycle (`:1103`), the 10-minute embedding backfill
   (`:1131`) — all run in-process. None exits.

**Frequency verdict.** On a healthy, stable box the restart rate is on the order of
**a few per month**: one per accepted update, one per OS reboot, plus whatever crash rate
the build carries. It is **not** a daily event, and there is no scheduled or watchdog-driven
cycling to make it one.

**But that does not make W79 a low-value fix**, for two reasons:
- **Update-apply is a guaranteed restart, and it is the single most dangerous moment** — it
  lands mid-life on a box with live sessions, and the watchdog's boot-sentinel/rollback
  machinery is already watching that window. Every user hits it on every release.
- **A restart-rehydration bug is not amortised by rarity — it is a correctness cliff.** When
  it fires, the session is wrong from that point forward until something resets it. A
  once-a-month event that silently corrupts a long-running session is worse, not better,
  than a daily one the user would have noticed and reported.

So: **rare-event per box, certain-event per release, and high-severity when it fires.**

---

## DEFECT FOUND (no fix applied, per order)

### D1 — The test suite writes into the user's real `~/.dojo`, and its log flood destroys the server's forensic log

**What.** `packages/server/src/logger.ts:6-8` resolves the log path from `os.homedir()` at
module load with **no environment override** — there is no `DOJO_HOME` / `DOJO_LOG_DIR` in
the codebase (`grep -rn "DOJO_HOME\|DOJO_DATA\|DOJO_LOG"` → no matches).
`db/connection.ts:8-9` does the same for the database. `services/public-share.ts:27` does the
same for `~/.dojo/out`.

`packages/server/package.json:10` runs `vitest run` with **no vitest config file anywhere in
the repo** — so no `setupFiles`, no `globalSetup`, no HOME redirection. Of 387 test files,
**126 call `runMigrations()`** and **179 do not mock `db/connection.js`**. Only a handful
redirect `$HOME` individually (e.g. `watchdog-self-integrity.test.ts:51`,
`secrets-file-mode.test.ts:20`, `assembly-validation-sink.test.ts:57`), and those are
hand-rolled per file.

**Evidence of impact, 2026-09-16 00:03 local:**

- **369** migration runs and **29** live-DB connections to `/Users/dcliff9/.dojo/data/dojo.db`
  in 14 seconds, from test processes.
- **~123,000 log lines** written into the owner's real `~/.dojo/logs/dojo.log` — 43,590 +
  78,723 of them from `component:"migrations"` alone, versus a few hundred real server lines.
- **30** share-bundle directories dumped into `~/.dojo/out/` (which now holds **19,390**
  entries — accumulated test residue).

**The destructive consequence.** `logger.ts:47-65` keeps exactly **one** backup and rotates
by *unlink-then-rename*:

```js
const rotatedPath = LOG_FILE + '.1';
if (fs.existsSync(rotatedPath)) { fs.unlinkSync(rotatedPath); }
fs.renameSync(LOG_FILE, rotatedPath);
```

The 60-second rotation throttle is a **module-level variable** (`lastRotateCheck`), so it is
per-process — ~30 concurrent test processes each carry their own. With 11 MB of migration
spam produced in seconds, the 10 MB threshold was crossed repeatedly and `dojo.log.1` was
unlinked and replaced more than once inside the storm. The proof is the file itself:
`dojo.log.1` is **11.7 MB but its first line is `07:03:34.384`** — it holds **seven seconds**
of content. Everything before that, including **the real boot record of pid 72320 at
06:59:29Z** and all prior server history, was deleted.

**Why this matters beyond hygiene.** This is precisely why the restart looked unexplained:
the only durable record of what the server actually did was overwritten by its own test
suite, and what replaced it *looked like* repeated boots. Any future incident on the owner's
box is one `npm test` away from being unforensicable. On a user box the same code path means
a log flood (from any source) silently discards history with only one 10 MB backup.

**Where:**
- `packages/server/src/logger.ts:6-8` (unconditional `os.homedir()` path), `:47-65`
  (single-backup unlink+rename rotation, per-process throttle at `:41`, `:49-51`)
- `packages/server/src/db/connection.ts:8-9` (unconditional live DB path)
- `packages/server/src/services/public-share.ts:27` (unconditional `~/.dojo/out`)
- `packages/server/package.json:10` — `vitest run` with no config, no setup file, no
  HOME isolation

**Not asserted:** I found **no** test-fixture rows in the live DB (`agents` = 114 real rows;
no `t72b*`/`test*` ids). The migration runs against the live DB appear to have been
idempotent no-ops. I did not audit every table and I made no writes — the DB check was
read-only (`mode=ro`).

### D2 (minor, dev-box only) — the test harness restarts the live dev server twice per probe

The dojo-test-kit server-instruments harness installs `gateway/routes/dev.ts` and patches
`services/imessage-bridge.ts` *inside the watched source tree*, so `tsx watch` bounces the
server on install **and** on uninstall — 47 restarts in five days, landing mid-session
during the owner's DS4 traffic. This is the mechanism behind "restarts with nobody editing
the tree." It affects the dev box only (production has no file watcher), but it makes every
harness-instrumented UX run a restart test whether or not that was intended.

---

## Files / evidence cited

- `/Users/dcliff9/.dojo/logs/devserver-w56.log` — the authoritative restart ledger (tsx stdout)
- `/Users/dcliff9/.dojo/logs/dojo.log`, `/Users/dcliff9/.dojo/logs/dojo.log.1` — the polluted structured log
- `/Users/dcliff9/.dojo/out/20260916-000349-*` — 30 test-fixture share bundles
- `/Users/dcliff9/Documents/Claude Code Projects/Agent Dojo Refresh/dojo/packages/server/src/logger.ts`
- `/Users/dcliff9/Documents/Claude Code Projects/Agent Dojo Refresh/dojo/packages/server/src/db/connection.ts`
- `/Users/dcliff9/Documents/Claude Code Projects/Agent Dojo Refresh/dojo/packages/server/src/db/migrations.ts`
- `/Users/dcliff9/Documents/Claude Code Projects/Agent Dojo Refresh/dojo/packages/server/src/index.ts` (`:100-118`, `:904-908`, `:1090`, `:1103`, `:1131`)
- `/Users/dcliff9/Documents/Claude Code Projects/Agent Dojo Refresh/dojo/packages/server/src/gateway/routes/update.ts` (`:593`, `:760-785`)
- `/Users/dcliff9/Documents/Claude Code Projects/Agent Dojo Refresh/dojo/packages/server/src/gateway/routes/system.ts` (`:280-315`)
- `/Users/dcliff9/Documents/Claude Code Projects/Agent Dojo Refresh/dojo/packages/server/src/services/public-share.ts` (`:27`)
- `/Users/dcliff9/Documents/Claude Code Projects/Agent Dojo Refresh/dojo/watchdog/src/index.ts` (`:37`, `:211-233`, `:844`, `:852-898`, `:1065-1077`, `:1181-1185`)
- `/Users/dcliff9/Documents/Claude Code Projects/Agent Dojo Refresh/dojo/deploy/install.sh` (`:230-320`)
- `/Users/dcliff9/Documents/Claude Code Projects/Agent Dojo Refresh/dojo/DOJO-ISSUES-LOG.md` (`:176`, `:1071-1074`) — harness manifest installing `routes/dev.ts`
