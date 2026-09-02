# W66 — stable v3.1.21 cut and published

**Result: PUBLISHED + PARITY.** Owner-ordered cut ("cut them as .21"). Delta: T69b only.

- Release commit: `35c8031` — `release: v3.1.21`
- Release page: https://github.com/d-cornerpin/dojo/releases/tag/v3.1.21
- Gate sha (the tree everything was measured at): `1764e9ac`

---

## 1. main fast-forwarded

`git merge-base main t69b-tail-holds-still` was `2557747` (v3.1.20) — the branch was cut from
the release commit directly, so this was a **clean fast-forward, no merge commit**, and the
W63 cherry-pick fallback was never needed.

```
2557747 (v3.1.20)  →  7c95ab5  →  9ad74d3  →  1764e9a
```

`t70b-share-moves-up` is byte-identical to `1764e9a` and was left alone, as instructed.

### Verification at `1764e9a`

| check | result |
|---|---|
| full server suite | **370 files / 5,308 tests, all passed**, 51.9s |
| typecheck (shared + server) | clean, exit 0 |
| blocking gates | **13/13 green** (`deploy/checks/gate-manifest.mjs`) |
| report instruments | 4 recorded, none blocking |

**Reds diffed against base: none to diff.** 5,308 green at `1764e9a`, which is the same count
the branch carried when it was accepted; zero failures on either side, so there is no delta to
account for. The release then re-ran the whole suite a second time, inside `release.sh`, and it
was green there too.

Gate-side notes from the report tier (unchanged from 3.1.20, recorded so they are not read as
new): capability ledger reports 1 built-but-absent (`pm-agent:startPokeLoop#2`) and 3
in-tree-but-unrecorded; waiver budget 1/5 across the arc. Both are REPORTING tiers and neither
moved in this delta.

---

## 2. Update-path audit — ZERO migrations, ZERO deps/env/config. Proven, not assumed.

**Migrations — proven by tree hash, which is stronger than a diff being empty:**

```
git rev-parse 2557747:packages/server/src/db   →  d9f3225386923b4f536fc944b73984720c4dc304
git rev-parse 1764e9a:packages/server/src/db   →  d9f3225386923b4f536fc944b73984720c4dc304
```

Identical object. The whole `db/` subtree — `migrations/`, `migrations.ts`, `connection.ts`,
`migration-backup.ts`, `migration-checksums.ts` — is byte-for-byte the same tree at both shas.
166 migration files at `2557747`, 166 at `1764e9a`. `packages/server/src/migration/` likewise
diffs empty. There is no migration step in this update, in either direction.

**Deps / env / config:** `git diff --stat 2557747 1764e9a` over `*package.json`,
`*package-lock.json`, `*.env*`, `*.npmrc`, `*tsconfig*`, `*.yml`, `*.yaml` returns **nothing**.

**The only `deploy/` change in the whole delta** is `deploy/checks/growth-baseline.json` — three
hand-moved line-count baselines (`outbound-ledger.ts` 355→459, `pre-call-injections.ts` 266→343,
`recall-lane.ts` 708→901) with their argument in-file. That is a gate baseline; it is not
shipped and it is not config a box reads.

So a 3.1.20 box takes this update, and rolls back from it, without touching stored data.

---

## 3. Kit prompt-gate record — regenerated at the release sha, 8/8

Re-run live (server up, instruments installed, then removed) and written fresh at `1764e9ac`:

```
check-cache-prefix        exit 0   GREEN
check-prompt-inventory    exit 0   GREEN
check-steer-delivery      exit 0   GREEN
check-message-prefix      exit 0   GREEN
check-assembled-context   exit 0   GREEN
check-reanswer-ghost      exit 0   GREEN
check-prefix-holds-still  exit 0   GREEN   ← the tail extension, on the roster
check-roster-conformance  exit 0   GREEN
```

`check-prefix-holds-still` is on the REQUIRED roster in `deploy/checks/check-prompt-gate-record.mjs`
(added by T67b) and its summary is the tail statement this release exists for: *"TAIL HELD — every
judged pair diverged only at a REGISTERED deliberate block (engine.recently-answered,
msg.relevant-memory, msg.directive, msg.current-time)."*

`check-prompt-gate-record.mjs` accepted it: **8 blocking gates green, 0 acknowledged reds, at
`1764e9ac`, 0.0h old** — and again inside `release.sh` at 0.1h old, against the same HEAD (the
version bump is uncommitted at that point, so HEAD is still the change-set sha, exactly as the
gate's own comment describes).

### Incident, recorded because it changed the tree

`node server-instruments/install.mjs --status` is **not** a status flag — the script does not
recognise it and **installed the instruments**. The tree went dirty (5 patched + 2 created).
Recovered deliberately rather than reverted blind: the record was regenerated while they were in
(which is the only way to produce one anyway), then `uninstall.mjs` was run — *"Uninstalled and
VERIFIED CLEAN. 12 change(s); 0 [DEV-INSTRUMENTS] markers left in packages/server/src"* — and
`git status --porcelain` was empty before anything else ran. The release's own ship-gate then
independently confirmed *"no dev instruments (sim-outbound / /api/dev) in packaged build"*, and so
did a grep over the downloaded artifact (§5). No instrument byte reached the release.

---

## 4. Goldens — nothing moved

`git diff --stat` over `dojo-test-kit/checks/golden/` is **empty**. Both goldens
(`cache-prefix.kevin.txt`, `assembled-context.json`) are untouched by the re-run. The only
modified file in the kit is `checks/results/prompt-gates.json` — the record itself, which is the
output this step exists to produce.

The two reserve moves the orchestrator named — **`lane.deliveries` 316→323** and
**`lane.relevant-memory` 2,179→2,203** — were already registered in `1764e9a`'s gate-side commit
(`ratchets.json`, with the per-term split stated beside the literals and each still pinned to its
generator by a test). Nothing moved beyond them.

---

## 5. Publish and post-publish verification

```
bash deploy/release.sh 3.1.21 --skip-behavioral-gate --notes-file <scratchpad>/RELEASE-NOTES-3.1.21.md
```

Notes were kept **outside the repo** on purpose: `release.sh` refuses on any dirty tree
(untracked included), and committing a notes file would have moved HEAD off `1764e9a` and
invalidated the prompt-gate record's sha match. This matches the 3.1.19 / 3.1.20 precedent (no
notes file is checked in for either).

Exit 0. Every check below was re-run **independently** after the script finished:

| check | result |
|---|---|
| prerelease | **false** |
| draft | **false** |
| target | `main` |
| assets | **3/3, all `uploaded`** — `dojo-platform.zip` 19,847,662 B · `Agent-DOJO-Installer.pkg` 18,878,039 B · `dojo-platform.zip.sha256` 84 B |
| sha round-trip | published `.sha256` manifest = `9cd2e14da2dd2d96989fe43d821b8c5fe40a65a5098fb20e388ac3961aff003d`; **recomputed from the zip downloaded back off GitHub: identical**; local `deploy/dist` zip: identical |
| `releases/latest` | **`v3.1.21`** |
| tag → commit | GitHub `refs/tags/v3.1.21` = `35c803153ed7a27efc51d81055179b3074cd2e75` = local tag |
| resolver — stable | `/releases/latest` HTTP 200 → **v3.1.21**, downloadUrl present |
| resolver — preflight | list + version-precedence sort → **v3.1.21** (the stable overtakes every pre-release, as designed) |
| a 3.1.20 box | sees an update available |
| notes body | 3,463 chars, opens `# Agent Dojo 3.1.21` (not an empty body, not a bare changelog link) |
| `origin/main` == local | both `35c8031` |
| working tree | clean |

**Greps over the artifact actually downloaded from GitHub** (unzipped, not the local build):

- `DEV-INSTRUMENTS` → **0 files**
- `sim-outbound` → **0 files**
- no `routes/dev.*`, no `sim-outbound.*` file anywhere in the package
- embedded version in the shipped `package.json` → **3.1.21**
- T69b's product files present: `dist/memory/message-stamp.js`, `dist/memory/recall-lane.js`

Two prose-only hits were run down rather than waved past: `dist/router/probe.js:28` (a comment
reading *"/api/dev and tune if probe volume is off"*) and `dist/services/imessage-bridge.d.ts:91`
(a docblock naming `gateway/routes/dev.ts`). Both are comments in files that ship normally; no
instrument code, no route registration.

No 5xx at any point.

---

## 6. Release notes

Short and plain, at the owner's framing. What they say: DOJO's internal end-of-prompt notes were
rewritten every turn even when nothing changed, for four reasons — "2 hours ago" phrasing worked
out at send time, lists ordered by match quality rather than a fixed order, the open-commitments
board glued onto the back of every per-question lookup, and the changeable blocks sitting ahead of
the stable ones. All four fixed.

**The honesty line is stated plainly and is not buried:** *"These are correctness fixes, and on
their own they are not a speed improvement. We did not measure a before-and-after speed change for
this release and are not claiming one."* The notes state what *was* measured (same facts ⇒
byte-identical notes turn to turn, where before they never were), say these sit on top of 3.1.20's
measured caching win, and say **how much they add to it has not been measured separately, so no
number is offered**. They also state there is no migration, no new setting, no new permission, and
they carry the required `--skip-behavioral-gate` line.

---

## 7. Preflight parity — fast-forward, as expected

`origin/Preflight` was at `2557747` (0 ahead / 4 behind main, merge-base = itself), so Procedure D
was a clean fast-forward with no conflicts:

```
Preflight  2557747  →  35c8031      pushed
```

`Preflight` = `origin/Preflight` = `main` = `origin/main` = tag `v3.1.21` = **`35c8031`**.
Working tree clean, nothing stashed, no processes left running.
