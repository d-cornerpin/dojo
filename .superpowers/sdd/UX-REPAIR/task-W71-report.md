# W71 — stable v3.1.22 cut and published

**Result: PUBLISHED + PARITY.** Owner-ordered ("Get everything together and then cut. Might as
well do this as one deploy."). Delta: the full shelf — T71b + T72b (four fixes) + T73b.

- Release commit: `7f4538f` — `release: v3.1.22`
- Release page: https://github.com/d-cornerpin/dojo/releases/tag/v3.1.22
- Gate sha (the tree everything was measured at): `b39d178a`

---

## 1. main fast-forwarded

`git merge-base main t73b-ceiling-lifts` was `63b9064` (v3.1.21) — t71b branched from the .21
report commit directly, so this was a **clean fast-forward, no merge commit**, exactly as the
orchestrator expected.

```
63b9064 (v3.1.21)
  → e0bb925  T71b: one ack, and the tool stops writing its own
  → 790e12a  T72b/4: the date leaves the cached prefix and rides the tail
  → f570ecd  T72b/2+3: the first-chunk grant survives an ack frame; the tools lane appends
  → 60580cf  T72b/1: a thinking model is not sent out with room for no answer
  → 1dd4b29  gate-side: seven ratchets raised and the new limits door recorded, for T72b
  → 2a27f6a  T73b: the socket is as patient as the row says it is
  → b39d178  gate-side: two ratchets raised, for T73b
```

Seven commits, all orchestrator-accepted before the cut.

### Verification at `b39d178`

| check | result |
|---|---|
| full server suite | **376 files / 5,359 tests, all passed**, 56.4s |
| typecheck (shared + server) | clean, exit 0 |
| blocking gates | **13/13 green** (`deploy/checks/gate-manifest.mjs`) |
| report instruments | 4 recorded, none blocking |

**Reds diffed against base: none to diff.** 5,359 green at `b39d178`, zero failures on either
side. Base was 5,308 across 370 files at `63b9064`; the delta adds 6 test files and 51 tests
and removes none that were passing (`agent/v2/__tests__/ack.test.ts` went with the classifier
T71b deleted). The release then re-ran the whole suite a second time inside `release.sh` and
got the identical **376 / 5,359**.

Gate-side notes from the report tier, recorded so they are not read as new: capability ledger
now carries the four rows T72b's `--write` added (one of them this delta's own —
`PATCH /api/config/models/:id/limits` — the other three pre-existing and previously
undeclared); the one recorded-but-absent row (`pm-agent:startPokeLoop#2`) is untouched; waiver
budget still **1/5** across the arc. Both tiers are REPORTING and neither blocked.

T73b's own commit recorded 2 failures (`work-event-kinds-conformance`, 5 s load-timeouts,
12/12 in isolation). **They did not reproduce here** — 5,359/5,359 on both of my runs and on
the release's. Flake, not a standing red.

---

## 2. Update-path audit

### Migrations — ZERO. Proven by tree hash, not by an empty diff.

```
git rev-parse 63b9064:packages/server/src/db  →  d9f3225386923b4f536fc944b73984720c4dc304
git rev-parse b39d178:packages/server/src/db  →  d9f3225386923b4f536fc944b73984720c4dc304

git rev-parse 63b9064:packages/server/src/migration  →  c498d82bea7898eb9a449d2570169135ed452e4c
git rev-parse b39d178:packages/server/src/migration  →  c498d82bea7898eb9a449d2570169135ed452e4c
```

Identical objects on both subtrees. 166 migration files at `63b9064`, 166 at `b39d178`. There
is no migration step in this update, in either direction, so a 3.1.21 box takes it and rolls
back from it without touching stored data.

### Dependencies — NOT zero. One new declared package, audited.

`undici@^7.29.1` is newly declared in `packages/server/package.json`. This is the whole
dependency delta and it is stated here rather than waved past.

| question | answer, with where it was checked |
|---|---|
| runtime or dev? | **runtime** — `dependencies.undici = ^7.29.1`; `devDependencies.undici` is undefined |
| lockfile delta | exactly **one** new package node: `node_modules/undici`, version **7.29.1**, `resolved` = `https://registry.npmjs.org/undici/-/undici-7.29.1.tgz`, integrity `sha512-RYONW2Me…` — plus the workspace's own dep line |
| license | **MIT** (stated in the lock entry and in the installed package) |
| actually used? | yes, on the production path — `import { Agent } from 'undici'` at `packages/server/src/agent/model.ts:3`; it is the only way to move `headersTimeout`/`bodyTimeout`, which is the whole of T73b |
| node floor | undici 7.29.1 declares `engines.node >= 20.18.1`. `deploy/install.sh:81` refuses anything under Node **22** and installs node@22 if absent. No conflict, and there is no `.npmrc` setting `engine-strict` either way |
| does the artifact carry it? | **yes, both manifests.** The published zip contains `platform/packages/server/package.json` declaring `^7.29.1` AND `platform/package-lock.json` pinning 7.29.1 with its integrity hash. `node_modules` is deliberately excluded from the zip (`build-package.sh:163`) — that is how every release ships |
| does a 3.1.21 box get it with no user action? | **yes.** The in-app update path runs `npm install --omit=dev` in `PLATFORM_DIR` after the file copy (`packages/server/src/gateway/routes/update.ts:737`; the rollback path does the same at `:988`). The shipped lockfile is beside it, so the 7.29.1 pin is honoured. **Nothing for the user to do**, and it is stated plainly in the release notes rather than left to be discovered |

The other lockfile hunk is cosmetic: the root lock header still read `3.1.17-preflight.22` at
`63b9064` and was resynced to `3.1.21` by an install on the branch.

### Env / config — zero.

`git diff --stat 63b9064 b39d178` over `*.env*`, `*.npmrc`, `*tsconfig*`, `*.yml`, `*.yaml`
returns nothing. No `deploy/` file changed at all in this delta.

### One new API surface, named.

`PATCH /api/config/models/:id/limits` (`packages/server/src/gateway/routes/config.ts:1966`),
recorded in `deploy/checks/capability-ledger.csv:477`. It is a PARTIAL update (only fields
present move) and NULL is a real value meaning "let discovery decide". It is the durable half
of T72b/1 and it is the one **new setting** in this release — surfaced on the Models page as a
max-output / context-window pair, and called out as new in the notes rather than hidden behind
the usual "no new setting" line.

---

## 3. Kit prompt-gate record — 8/8 at the release sha

```
check-cache-prefix        exit 0   GREEN
check-prompt-inventory    exit 0   GREEN
check-steer-delivery      exit 0   GREEN
check-message-prefix      exit 0   GREEN
check-assembled-context   exit 0   GREEN
check-reanswer-ghost      exit 0   GREEN
check-prefix-holds-still  exit 0   GREEN
check-roster-conformance  exit 0   GREEN
```

`check-prompt-gate-record.mjs` accepted it twice — **8 blocking gates green, 0 acknowledged
reds, at `b39d178a`, 0.1h old** on my own run, and again inside `release.sh` at 0.2h old
against the same HEAD.

**I did not re-run the roster, and that is a deliberate call rather than a skipped step.** The
record was already produced at the exact release sha: `b39d178` was committed 14:20:19, the
record was written 14:23:54 by `dojo-test-kit/checks/run-prompt-gates.mjs` with instruments
installed, and the gate's own window is 24h. Re-running would have meant re-installing the
instruments into the very tree being shipped — the incident W66 recorded — to regenerate a
byte-equivalent record at the same sha from the same dev-box state. What I did instead was
verify it independently rather than trust it: the sha matches HEAD, the age is real (file
mtime 14:23, three and a half minutes after the commit it names), and the tree it was taken
out of is clean — **0 files carrying `DEV-INSTRUMENTS` and 0 carrying `sim-outbound` in
`packages/server/src`**, before the release and after it. The release's own ship-gate then
confirmed the same of the packaged build, and so did a grep over the artifact downloaded back
off GitHub (§5).

---

## 4. Goldens — nothing NEW moved

The kit's two goldens (`checks/golden/cache-prefix.kevin.txt`,
`checks/golden/assembled-context.json`) were last touched by **`c3924b1`** — "the date
exemption is retired and two goldens re-blessed (T72b/4)" — which is in-branch lineage and
expected. The kit's HEAD commit `872c987`, the roster re-run against T73b, touched **one file
and it was the record itself**:

```
872c987  checks/results/prompt-gates.json | 30 +++++-----------
         1 file changed
```

`git -C ../dojo-test-kit status --porcelain` is empty before the release and after it. In the
platform repo, `git diff --stat 63b9064 b39d178` over
`packages/server/src/agent/__tests__/__goldens__/` is likewise empty. No golden moved that was
not already registered.

Two ratchet batches (`1dd4b29`, seven raises; `b39d178`, two) carry their argument in
`ratchets.json`'s `$raises` and passed the ratchet gate inside the release.

The release's own C28 cache-prefix determinism gate reports **23,897 chars, byte-identical
across states, systemVolatile empty, smell-free**. That number was 23,845 at .21. The gate
tests byte-INVARIANCE, not size, and it passed; the size moved because this delta deliberately
rewrote what is in the prefix (T72b/4 took the date out of `sys.time`, T72b/3 reordered the
tools lane, `tool-docs.ts` changed). I am reporting the number rather than decomposing it,
because I did not measure the per-term split myself.

---

## 5. Publish and post-publish verification

```
bash deploy/release.sh 3.1.22 --skip-behavioral-gate \
  --notes-file <scratchpad>/RELEASE-NOTES-3.1.22.md
```

Notes kept **outside the repo** on purpose, per the .19/.20/.21 precedent: `release.sh` refuses
on any dirty tree including untracked files, and committing a notes file would have moved HEAD
off `b39d178` and invalidated the prompt-gate record's sha match.

Exit 0. Every check below was re-run **independently** after the script finished:

| check | result |
|---|---|
| prerelease | **false** |
| draft | **false** |
| target | `main` |
| published | 2026-09-12T21:36:30Z |
| assets | **3/3, all `uploaded`** — `dojo-platform.zip` 19,868,350 B · `Agent-DOJO-Installer.pkg` 18,897,126 B · `dojo-platform.zip.sha256` 84 B |
| sha round-trip | published `.sha256` manifest = `e51b65a4ea00e3a1e6f6c243c444125a4d3d5c069f6e910552e5560efbda5e45`; **recomputed from the zip downloaded back off GitHub: identical**; local `deploy/dist` zip: identical (three-way) |
| `releases/latest` | **`v3.1.22`** |
| tag → commit | GitHub `refs/tags/v3.1.22` = `7f4538ff5affdf85b825c76a3970990ec92a0596` = local tag |
| resolver — stable | `/releases/latest` HTTP 200 → **v3.1.22**, draft false, prerelease false, downloadUrl present, 19,868,350 B |
| resolver — preflight | list + version-precedence sort over 30 → **v3.1.22** (the stable overtakes every pre-release, as designed; runners-up v3.1.21, v3.1.20, v3.1.19, v3.1.19-preflight.1) |
| a 3.1.21 box | `compareVersions('3.1.22','3.1.21')` = **1 → update available: true**; a 3.1.22 box sees none (0). Run against `dist/gateway/routes/update.js`, proven byte-identical (sha256 `a06ff765…`) to the copy inside the published zip |
| notes body | 5,555 chars, opens `# Agent Dojo 3.1.22`, carries the `--skip-behavioral-gate` line and the undici line |
| `origin/main` == local | both `7f4538f` |
| working tree | clean; kit clean; nothing stashed; no processes left running |

No 5xx at any point.

**Greps over the artifact actually downloaded from GitHub** (unzipped, not the local build):

- `DEV-INSTRUMENTS` → **0 files**
- `sim-outbound` → **0 files**
- no `routes/dev.*`, no `sim-outbound.*` anywhere in the package
- embedded version in the shipped `package.json` → **3.1.22**
- this delta's product files present and carrying the change: `dist/agent/stream-patience.js`,
  `dist/agent/model.js` (6 `undici` references), `dist/gateway/routes/config.js` (2 hits for
  `models/:id/limits`)

### One finding, run down rather than waved past

`dist/agent/v2/classifiers/ack.js` **ships, and its source no longer exists.** T71b deleted
`packages/server/src/agent/v2/classifiers/ack.ts`; `tsc` does not prune orphaned outputs and
`build-package.sh` copies `dist/` as-is, so the Sep 1 build product rode into the zip while
every sibling in that directory is dated Sep 12.

I checked whether it can do anything, and it cannot:

- **Nothing imports it.** `grep -rn "classifiers/ack"` over the shipped `dist`, sourcemaps
  excluded, returns nothing.
- **Its three exports have no consumer.** `SELF_ACKNOWLEDGING_TOOLS`, `ackInjector`,
  `DEFAULT_ACK_TEXT` appear only inside `ack.js`/`ack.d.ts` themselves and in one **comment**
  at `dist/agent/v2/loop.js:546` that records the deletion.
- It is unreachable dead code: no route registration, no import side effect, 76 lines.

Scope: I walked every `.js` in `dist` against its `src` counterpart — **this is the only
orphan in the whole tree**, so it is not a standing property of the build, it is this delta's
deletion leaving a stale output. Not a ship-stopper and not a behaviour risk, but it is a real
build-hygiene gap (`dist/` is never cleaned between builds) and the next deletion will do the
same thing. Worth a `rm -rf dist` step or a clean flag in `build-package.sh`; left for the
orchestrator to route rather than fixed inside a release cut.

The one other prose hit — `dist/agent/tools/cat/media.js:34`, "synthetic acknowledgment" — is
T71b's own demolition record ("It is deleted, in all three, and none of it is replaced"), a
comment in a file that ships normally.

---

## 6. Release notes

Short and plain, in two parts: the multi-image annoyance, then the five self-hosted-model
faults. What they say, in the owner's framing: ask for three images and get one "on it"; and
for people running their own model server — a thinking model is no longer sent out with no
room to answer (plus the two numbers that decide it are now editable), a queue-time ack frame
no longer eats the wait-for-the-first-word allowance, an allowance above five minutes is now
actually honoured, loading a tool mid-conversation no longer reshuffles the block sent ahead
of everything, and the date has left the first line of the prompt so midnight no longer
rebuilds it.

**The honesty lines are stated plainly and are not buried.** The notes separate what was
measured from what was not:

- The five-minute ceiling **does** carry a driven before-and-after and it is given: same call,
  400 s allowance, server silent 310 s — 3.1.21 killed the connection at 301 s with no answer,
  3.1.22 answered at 310 s. Stated as **one shape, not a general speed claim.**
- The two cache items are named as **correctness fixes, not a speed improvement**, with "we
  did not measure a before-and-after number for this release and are not offering one."
- "If your model server is genuinely slow, none of this makes it faster."
- No migration, no new permission — and then, instead of the usual "nothing new": **there is a
  new setting** (optional, max output / context window per model) and **this update installs
  one new package** (`undici`, MIT, 7.29.1), fetched automatically, nothing for the user to do.
- The required `--skip-behavioral-gate` line is carried.

---

## 7. Preflight parity — fast-forward, as expected

`origin/Preflight` was at `63b9064`, identical to where main started (0 ahead / 0 behind,
merge-base = itself), so Procedure D was a clean fast-forward with no conflicts.

```
Preflight  63b9064  →  7c75565      pushed
```

`Preflight` = `origin/Preflight` = `main` = `origin/main` = `7c75565`, which is this report
committed on top of tag `v3.1.22` = `7f4538f`. Working tree clean, kit clean, nothing stashed,
no processes left running.
