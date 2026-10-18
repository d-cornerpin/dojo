#!/bin/bash
set -euo pipefail

# ════════════════════════════════════════════════════════════════════════
# DOJO release — one command, fully verified.
#
# Cuts a release end-to-end and REFUSES to report success unless the GitHub
# release actually carries all three assets and the self-update path resolves.
# This exists because every past release failure was the same shape: the
# version got bumped, committed, tagged, pushed, and a release page created,
# but the .zip/.pkg were never uploaded — so every user's self-update saw the
# new version and then failed to download it.
#
# Usage:
#   bash deploy/release.sh <version> [--dry-run] [--notes-file <path>]
#   e.g.  bash deploy/release.sh 3.0.4
#         bash deploy/release.sh 3.0.4 --dry-run     # build + verify, no push
#
# --dry-run does everything locally (bump, build, verify the embedded version)
# then reverts the bump WITHOUT committing/pushing/releasing. Use it to prove a
# release will go cleanly before doing it for real.
# ════════════════════════════════════════════════════════════════════════

REPO="d-cornerpin/dojo"
ZIP_NAME="dojo-platform.zip"
PKG_NAME="Agent-DOJO-Installer.pkg"
# PHASE-5 T6B: the sha256 manifest the self-updater verifies the zip against
# before it rsyncs anything over a running install. It is published BESIDE its
# own artifact, so it proves the bytes arrived intact — it is NOT proof of who
# made them; that needs a signature checked against a key the platform holds.
# Read by packages/server/src/update/artifact-integrity.ts.
SHA_NAME="dojo-platform.zip.sha256"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$SCRIPT_DIR/dist"

DRY_RUN=0
PREFLIGHT=0
SKIP_BEHAVIORAL=0
NOTES_FILE=""
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --preflight) PREFLIGHT=1; shift ;;
    # Owner-authorized bypass of the behavioral-suite gate for THIS invocation
    # only. Deliberately a FLAG, not an env var (env-var toggles here caused an
    # accidental publish once; a flag must be typed on purpose, every time).
    # Only use it when the owner explicitly said this push may skip the suite;
    # every other gate (smoke boot, cache prefix, dev instruments, asset
    # verification) still runs.
    --skip-behavioral-gate) SKIP_BEHAVIORAL=1; shift ;;
    --notes-file) NOTES_FILE="${2:-}"; shift 2 ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) VERSION="$1"; shift ;;
  esac
done

# ── One cleanup path for every way this script can end (PHASE-0 T13) ──
# An abandoned run must leave the tree exactly as it found it, and there are
# three ways to abandon one: a gate says no, someone presses ctrl-c, or the
# process is killed. All three used to leave package.json rewritten at the new
# version — so the tree was dirty, the NEXT release refused at its preconditions
# with "working tree is not clean", and the actual reason ("we bumped and then a
# gate said no") was three screens up. It was observed for real during T13's own
# dry run, when the run was interrupted mid-flight.
#
# The bump is not a decision, it is a step. It is reverted only while it is
# UNCOMMITTED: once the release commit exists the bump is real, and reverting it
# would be the destructive act rather than the safe one.
#
# This is also the single owner of the smoke-sandbox teardown. Two separate
# `trap ... EXIT` statements were racing for that job, and the second silently
# replaced the first — one owner per job.
CURRENT=""
BUMPED=0
COMMITTED=0
cleanup() {
  local code=$?
  if [ "$BUMPED" = "1" ] && [ "$COMMITTED" = "0" ]; then
    git checkout -- package.json 2>/dev/null \
      && echo "  ↪ reverted the uncommitted version bump; package.json is back at $CURRENT" >&2
  fi
  [ -n "${SMOKE_PID:-}" ] && { kill "$SMOKE_PID" 2>/dev/null || true; }
  [ -n "${SMOKE_DIR:-}" ] && rm -rf "$SMOKE_DIR"
  return $code
}
trap cleanup EXIT
trap 'echo "" >&2; echo "interrupted — cleaning up" >&2; exit 130' INT TERM

fail() { echo "" >&2; echo "❌ $*" >&2; exit 1; }
step() { echo ""; echo "▶ $*"; }

# ── ONE PLACE RESOLVES THE TEST KIT (t112, 2026-10-05) ──────────────────────────────────
# The kit is a SIBLING repo, not a submodule, and three gates below read files out of it.
# Every one of those reads used to spell its own path as `$SCRIPT_DIR/../../dojo-test-kit`,
# which is correct from the MAIN checkout and wrong from anywhere else: a git worktree sits
# one level deeper, so `../..` lands in `worktrees/` and the behavioral marker, the floor
# model and the ritual shape all resolve to a path that does not exist. The gate that reads
# the marker then refuses with "no last-green marker at <a path nobody has>", which reads as
# "run the suite" and is really "this checkout cannot see the kit" — and the pressure that
# produces is `--skip-behavioral-gate`, which is the one thing these gates exist to avoid.
#
# So the kit is resolved ONCE, loudly, and the answer is EXPORTED: `check-ritual-parity.mjs`
# already honours `DOJO_TEST_KIT` and already tries both layouts, so exporting what this
# script resolved makes the bash side and the node side name the same directory instead of
# each guessing. A caller who knows better still wins — an inherited `DOJO_TEST_KIT` is taken
# as given and never second-guessed.
#
# It is a FUNCTION, called from inside the behavioral block, not a line at file scope: with
# `--skip-behavioral-gate` the owner has said this cut does not read the kit at all, and a
# refusal at startup would turn an authorized skip into an impossible release.
KIT_DIR=""
KIT_MARKER='behavioral/lib/release-ritual.mjs'

# Sets KIT_DIR and exports DOJO_TEST_KIT when a kit is found; returns 1 when none is, WITHOUT
# failing — so a `--skip-behavioral-gate` run on a box with no kit still cuts, and the gates
# that merely prefer a kit (check-ritual-parity.mjs skips loudly without one) see the same
# directory this script resolved rather than guessing separately.
find_kit() {
  [ -n "$KIT_DIR" ] && return 0
  local declared="${DOJO_TEST_KIT:-}"
  local c
  if [ -n "$declared" ]; then
    if [ -f "$declared/$KIT_MARKER" ]; then
      KIT_DIR="$(cd "$declared" && pwd)"
      export DOJO_TEST_KIT="$KIT_DIR"
      return 0
    fi
    # A DECLARED path that is not a kit is a typo, never a box without a kit. Saying so here
    # rather than returning 1 stops it from being silently re-guessed into a sibling.
    fail "Test kit: DOJO_TEST_KIT=$declared carries no $KIT_MARKER, so it is not a dojo-test-kit checkout. The behavioral, floor-model and ritual gates all read their evidence out of that repo and cannot be answered from a wrong path. Point DOJO_TEST_KIT at the kit, or clear it to let this script search beside the checkout. NOT publishing."
  fi
  for c in "$ROOT/../dojo-test-kit" "$ROOT/../../dojo-test-kit"; do
    if [ -f "$c/$KIT_MARKER" ]; then
      KIT_DIR="$(cd "$c" && pwd)"
      export DOJO_TEST_KIT="$KIT_DIR"
      return 0
    fi
  done
  return 1
}

# The same question, asked where the answer is REQUIRED: a loud refusal naming both layouts
# it looked under, because the failure this replaces ("no last-green marker at <a path nobody
# has>") read as "run the suite" when it meant "this checkout cannot see the kit".
resolve_kit() {
  find_kit && return 0
  fail "Test kit: no dojo-test-kit found. Looked for $KIT_MARKER under $ROOT/../dojo-test-kit and $ROOT/../../dojo-test-kit. This checkout is not the one the kit sits beside (a git worktree is one level deeper than the main checkout), so the behavioral-suite, floor-model and release-ritual gates have no evidence to read and a green from them would mean nothing. Set DOJO_TEST_KIT=/path/to/dojo-test-kit and re-run. NOT publishing."
}

# Prerelease-aware "strictly greater": exit 0 iff version $1 ranks strictly
# ABOVE version $2. Mirrors the engine's compareVersions (packages/server/src/
# gateway/routes/update.ts) EXACTLY so this gate matches how a box actually
# resolves the newest release: higher base wins; a stable release outranks any
# pre-release of the SAME base (so 3.1.10-preflight.1 ranks BELOW stable 3.1.10);
# two pre-releases compare by ordinal; malformed segments clamp to 0 (FA-D7).
rank_above() {
  node -e '
    function parse(v){
      const s=String(v).replace(/^v/,"");const d=s.indexOf("-");
      const bp=d===-1?s:s.slice(0,d);const pt=d===-1?"":s.slice(d+1);
      const base=bp.split(".").map(x=>{const n=Number(x);return Number.isFinite(n)?n:0;});
      let pre=null;if(pt){const m=pt.match(/(\d+)\s*$/);pre=m?Number(m[1]):0;}
      return {base,pre};
    }
    function cmp(a,b){a=parse(a);b=parse(b);
      for(let i=0;i<3;i++){const d=(a.base[i]||0)-(b.base[i]||0);if(d)return d;}
      if(a.pre===null&&b.pre===null)return 0;
      if(a.pre===null)return 1;if(b.pre===null)return -1;return a.pre-b.pre;}
    process.exit(cmp(process.argv[1],process.argv[2])>0?0:1);
  ' "$1" "$2"
}

# True iff tag $1 exists locally AND points at the current HEAD commit. Used to
# detect a re-entry (FA-D3): a prior run that committed the bump, created and
# pushed the tag, then failed at `gh release create`.
tag_points_at_head() {
  git rev-parse "$1" >/dev/null 2>&1 \
    && [ "$(git rev-parse "$1^{commit}" 2>/dev/null)" = "$(git rev-parse HEAD 2>/dev/null)" ]
}

# Stable needs an explicit X.Y.Z (released as vX.Y.Z from `main`). Preflight
# AUTO-PICKS its number — latest stable + 1 patch — and auto-increments the
# pre-release ordinal, so nobody has to choose it (the common foot-gun). You may
# still pass an explicit base to --preflight to target a bigger bump (e.g. 3.2.0).
# Preflight publishes vX.Y.Z-preflight.N from the `Preflight` branch.
# See deploy/RELEASES.md for the full process + numbering rules.
if [ "$PREFLIGHT" = "0" ] && [ -z "$VERSION" ]; then
  fail "Usage: bash deploy/release.sh <X.Y.Z> [--dry-run] [--notes-file <path>]   (preflight: --preflight [<X.Y.Z>])"
fi
if [ -n "$VERSION" ]; then
  echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "Base version must be X.Y.Z (got: $VERSION)"
fi
BASE="$VERSION"

cd "$ROOT"

if [ "$PREFLIGHT" = "1" ]; then
  EXPECTED_BRANCH="Preflight"
  CHANNEL_LABEL="Preflight (pre-release)"
else
  EXPECTED_BRANCH="main"
  CHANNEL_LABEL="Stable"
fi

# ── Preconditions (fail before changing anything) ──
step "Checking preconditions"
command -v gh >/dev/null 2>&1 || fail "gh CLI not found"
if ! gh auth status >/dev/null 2>&1; then fail "gh is not authenticated (run: gh auth login)"; fi
BRANCH="$(git branch --show-current)"
[ "$BRANCH" = "$EXPECTED_BRANCH" ] || fail "$CHANNEL_LABEL releases are cut from '$EXPECTED_BRANCH' (currently on: $BRANCH)"
if [ -n "$(git status --porcelain)" ]; then fail "Working tree is not clean. Commit or stash everything first."; fi
CURRENT="$(node -p "require('./package.json').version")"

if [ "$PREFLIGHT" = "1" ]; then
  # We ALWAYS need the latest stable now: to auto-pick the base when none was
  # given, AND (FA-D2) to GUARD that the resulting preflight tag ranks strictly
  # above it. Before FA-D2 the guard lived only in the auto-pick branch, so an
  # explicit base (e.g. `--preflight 3.1.9` while stable is 3.1.10) skipped it
  # and published a pre-release every box ignores, silently stranding the
  # feature under test with a "success" report.
  LATEST_STABLE="$(gh api "repos/$REPO/releases/latest" --jq '.tag_name' 2>/dev/null | sed 's/^v//')"
  echo "$LATEST_STABLE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || fail "Could not read latest stable release to compute/guard the preflight base (got '${LATEST_STABLE:-none}')."
  if [ -z "$BASE" ]; then
    BASE="$(echo "$LATEST_STABLE" | awk -F. '{printf "%d.%d.%d", $1, $2, $3 + 1}')"
    echo "  ↪ auto base: latest stable $LATEST_STABLE → preflight target $BASE"
  fi
  # Auto-increment the pre-release ordinal for this base: highest existing
  # vBASE-preflight.N on GitHub, plus 1. The trailing `|| true` is required —
  # under `set -euo pipefail`, grep finding no matches (the FIRST preflight build
  # for a base) makes the pipeline exit non-zero and would abort the script.
  LAST_N="$(gh release list --repo "$REPO" --limit 100 2>/dev/null \
    | grep -oE "v${BASE}-preflight\.[0-9]+" | sed -E 's/.*preflight\.//' | sort -n | tail -1 || true)"
  NEXT_N=$(( ${LAST_N:-0} + 1 ))
  VERSION="${BASE}-preflight.${NEXT_N}"
  TAG="v$VERSION"
  # Rank guard (FA-D2): the FULL preflight tag must rank strictly above latest
  # stable, whether the base was auto-picked OR given explicitly. A base equal
  # to stable is the classic trap, 3.1.10-preflight.1 ranks BELOW stable
  # 3.1.10 (a stable outranks its own pre-releases), so the box takes stable and
  # drops the feature. This is verbatim the preserved invariant.
  if ! rank_above "$VERSION" "$LATEST_STABLE"; then
    SUGGEST="$(echo "$LATEST_STABLE" | awk -F. '{printf "%d.%d.%d", $1, $2, $3 + 1}')"
    fail "Preflight $VERSION does NOT rank above current stable $LATEST_STABLE, every Preflight box would treat stable as newer, install it, and silently drop the feature under test. Use a base at least one patch above stable (e.g. --preflight $SUGGEST), or just run --preflight with no base to auto-pick it."
  fi
  echo "  ✓ $VERSION ranks above current stable $LATEST_STABLE"
else
  VERSION="$BASE"
  TAG="v$VERSION"
  # Stable must strictly increase over the current version, UNLESS we are
  # re-entering an interrupted release (FA-D3), where the bump is already
  # committed so CURRENT already equals VERSION and the tag sits at HEAD.
  # Uses rank_above (the engine-mirroring, prerelease-aware comparator) on
  # purpose: when a promotion fast-forwards main over Preflight release
  # commits, CURRENT is a pre-release string (e.g. 3.1.10-preflight.33) and
  # the stable of the SAME base must rank ABOVE it, exactly as every box's
  # updater resolves it. The old inline compare stripped the pre-release
  # suffix and saw the two as equal, wrongly refusing the promotion cut.
  if ! tag_points_at_head "$TAG" && ! rank_above "$VERSION" "$CURRENT"; then
    fail "New version $VERSION must be greater than current $CURRENT"
  fi
fi

# Re-entry detection (FA-D3). A prior run may have committed the bump, created +
# pushed the tag, then FAILED at `gh release create`, leaving branch+tag
# advanced with NO consumable release. Re-running must RESUME, not abort. We are
# re-entering iff the tag already exists locally at HEAD; any other pre-existing
# tag is a genuine conflict and still hard-fails. The late steps below are all
# idempotent, so a resumed run finishes the release rather than erroring.
REENTRY=0
if git rev-parse "$TAG" >/dev/null 2>&1; then
  if tag_points_at_head "$TAG"; then
    REENTRY=1
    echo "  ↪ re-entry: local tag $TAG already at HEAD, resuming an interrupted release"
  else
    fail "Tag $TAG already exists locally at a DIFFERENT commit than HEAD. Delete it (git tag -d $TAG) or choose another version before re-running."
  fi
fi
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  # A release row already exists. If we're resuming (tag at HEAD), that's fine -
  # the create step below falls through to an idempotent asset re-upload. If we
  # are NOT resuming, this tag was already fully released; refuse to clobber it.
  [ "$REENTRY" = "1" ] || fail "Release $TAG already exists on GitHub and no matching local tag is at HEAD. Nothing to resume; pick a new version."
  echo "  ↪ re-entry: release $TAG already exists, will ensure all three assets are uploaded, then verify"
fi
echo "  ✓ on $BRANCH, clean tree, gh authed, $CHANNEL_LABEL, $CURRENT → $VERSION, tag $TAG $([ "$REENTRY" = "1" ] && echo '(re-entry)' || echo 'free')"

# ── Typecheck (a broken build must never ship) ──
step "Typecheck"
npm run typecheck
( cd packages/dashboard && npx tsc --noEmit -p tsconfig.json )
echo "  ✓ server, shared, dashboard typecheck clean"

# ════════════════════════════════════════════════════════════════════════
# THE PHASE-0 GATE STACK (wired here by PHASE-0 T13 Step 2)
#
# `npm run gates` is two named tiers and a release runs BOTH:
#   gates:block (10) — each one refuses the release, in this exact order.
#   gates:report (4) — instruments that never stop a build; their output is
#                      CAPTURED into the release record instead of discarded,
#                      because "reported and nobody read it" is how a phase
#                      ends up net-positive with no accounting.
#
# All of these read SOURCE, so they run BEFORE the version bump, per this
# script's own "fail before changing anything" rule — and before it, because
# check-deletion-ratio refuses to report on a dirty tree and the bump makes the
# tree dirty. Cheap and static (except lint, tens of seconds); none is skippable
# and --skip-behavioral-gate does not skip any of them.
#
# ONE ORDERING DEVIATION, deliberate: the 10th blocking gate,
# check-upgrade-bypass, needs a LIVE server. It runs further down against the
# packaged artifact this script smoke-boots — the actual thing being shipped,
# rather than the working tree — with --require-live so a missing server fails
# instead of skipping. See "Upgrade-header auth-bypass gate" below.
# ════════════════════════════════════════════════════════════════════════

# The release record collects what the report tier measured, plus every
# acknowledged red, so the cut is described by its own outputs rather than by
# whoever writes the notes. Copied into deploy/dist at the end.
RELEASE_RECORD="$(mktemp)"
{
  echo "# Release record — $CHANNEL_LABEL"
  echo ""
  echo "- cut at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- branch: $BRANCH"
  echo "- HEAD:   $(git rev-parse HEAD)"
  echo ""
} > "$RELEASE_RECORD"

# ── THE BLOCKING GATES — read from deploy/checks/gate-manifest.mjs ──
# There used to be nine hand-written blocks here plus a tenth further down, each
# carrying a hand-typed `N/10` in its comment — and that comment was the ONLY thing
# binding this list to package.json's `gates:block`. It did not hold. PHASE-1 T11
# added `check-watchdog-sql.mjs` (renamed `check-sql-prepares.mjs` when PHASE-3 T8G
# took it whole-tree) to `npm run gates:block` and NOT to this file, so
# the one path that publishes to a user's box was the one path that did not run it;
# it was found two phases later by T13 counting the tiers by hand.
#
# The list now lives in ONE place and both consumers read it. The first gate below is
# `check-gate-manifest.mjs`, which refuses when the two consumers drift, when a
# `deploy/checks/check-*.mjs` exists that no tier names, or when a release-only gate
# goes missing from this file. Each gate's reasoning moved into the manifest and now
# sits beside its declaration instead of beside one of its two invocations.
#
# Gate 10/10 (upgrade-header auth bypass) is declared `post-smoke` and runs further
# down, against the packaged artifact — that difference is DECLARED in the manifest
# rather than left to be re-derived by counting.
# Probe for the kit BEFORE the gates run, without refusing: `check-ritual-parity.mjs` reads
# `DOJO_TEST_KIT` and otherwise guesses between two layouts, so exporting what this script
# resolved makes the bash side and the node side name one directory. No kit found is not a
# refusal here — that belongs to `resolve_kit` at the behavioral gate, which is the place the
# kit is actually REQUIRED and the place `--skip-behavioral-gate` can excuse.
find_kit || true

GATE_ROWS="$(node "$SCRIPT_DIR/checks/gate-manifest.mjs" --emit blocking pre-build)" \
  || fail "Gate manifest: deploy/checks/gate-manifest.mjs could not be read. NOT publishing."
GATE_TOTAL="$(printf '%s' "$GATE_ROWS" | grep -c . || true)"
[ "${GATE_TOTAL:-0}" -ge 8 ] \
  || fail "Gate manifest: only ${GATE_TOTAL:-0} pre-build blocking gate(s) declared; a gate list that empties itself passes every release. NOT publishing."

# ── EACH ROW'S DECLARED RELEASE ARGS ARE PASSED (t112, 2026-10-05) ──────────────────────
# Both loops below read a `releaseArgs` column off the manifest and then ran `node $script`
# with nothing after it. So the column was inert: a gate could be declared with a
# release-time flag it needs — `--require-kit`, `--require-live`, `--require-artifact` are
# all real flags that turn a SKIP into a refusal — and the release would run it without the
# flag and accept its skip as a green. Nothing failed; the gate simply answered a weaker
# question than the manifest said it was asked. (Harmless on the day it was found: every
# pre-build row declared no args, and the three post-smoke rows that do are invoked by hand
# further down WITH their flags. That is the ONLY reason it never shipped a false green.)
#
# `eval` and not word-splitting, deliberately: the column is declared SHELL SOURCE
# (gate-manifest.mjs spells the post-smoke rows `"$SMOKE_PORT"`, `"$(git rev-parse HEAD)"`),
# which is the whole point of having it — a release-time arg that cannot name a release-time
# value is not worth declaring. The manifest is a tracked, gate-side file in this repo and
# reaches here only through `check-gate-manifest.mjs`, which is itself gate 1/14.
run_gate() {
  # $1 = script path relative to ROOT, $2 = the declared args as shell source (may be empty)
  if [ -n "$2" ]; then
    eval "node \"\$ROOT/\$1\" $2"
  else
    node "$ROOT/$1"
  fi
}

GATE_N=0
while IFS=$'\x1f' read -r g_id g_script g_args g_title g_fail; do
  [ -n "$g_id" ] || continue
  GATE_N=$((GATE_N + 1))
  step "Blocking gate $GATE_N/$GATE_TOTAL: $g_title"
  run_gate "$g_script" "$g_args" || fail "$g_fail"
done <<__GATE_ROWS__
$GATE_ROWS
__GATE_ROWS__
[ "$GATE_N" -eq "$GATE_TOTAL" ] \
  || fail "Gate manifest: ran $GATE_N of $GATE_TOTAL declared pre-build blocking gates. NOT publishing."
echo ""
echo "  ✓ $GATE_N/$GATE_TOTAL pre-build blocking gates green (declared in deploy/checks/gate-manifest.mjs)"

# ── The report tier — also read from the manifest ──
# These measure rather than refuse — mixed timestamp formats, a stale resume pointer,
# capability the tree lost, and the phase's real added/deleted/net line counts.
# Non-negotiable #7: no phase passes or fails on a line count, but a net-positive phase
# owes an accounting, and the accounting starts with the numbers being IN the release
# record instead of on a terminal nobody kept. Nothing here can fail the release: a
# report tier that can fail a release is a blocking tier wearing the wrong name.
# The instrument list was hand-typed here too; it now comes from the same manifest, so
# a new instrument cannot reach one consumer and miss the other.
REPORT_ROWS="$(node "$SCRIPT_DIR/checks/gate-manifest.mjs" --emit report)" \
  || fail "Gate manifest: the report tier could not be read. NOT publishing."
REPORT_TOTAL="$(printf '%s' "$REPORT_ROWS" | grep -c . || true)"
step "Report tier (${REPORT_TOTAL:-0} instruments — recorded into the release record, never blocking)"
{
  echo "## Report tier (never blocking — measured, recorded, judged by the exit review)"
  echo ""
  echo '```'
} >> "$RELEASE_RECORD"
REPORT_N=0
while IFS=$'\x1f' read -r r_id r_script r_args r_title r_fail; do
  [ -n "$r_id" ] || continue
  REPORT_N=$((REPORT_N + 1))
  {
    echo "── $r_id ──"
    run_gate "$r_script" "$r_args" 2>&1 || echo "(exit $? — report tier, not blocking)"
    echo ""
  } >> "$RELEASE_RECORD"
  echo "  · $r_id recorded"
done <<__REPORT_ROWS__
$REPORT_ROWS
__REPORT_ROWS__
echo '```' >> "$RELEASE_RECORD"
echo "" >> "$RELEASE_RECORD"
echo "  ✓ $REPORT_N report-tier instrument(s) captured into the release record"

# ── Bump version ──
step "Bumping root package.json → $VERSION"
node -e "const f='package.json',p=require('./'+f);p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
BUMPED=1

# ── Build the deploy package ──
step "Building deploy package (this compiles everything)"
npm run build:package
[ -f "$DIST/$ZIP_NAME" ] || fail "Build did not produce $ZIP_NAME"
[ -f "$DIST/$PKG_NAME" ] || fail "Build did not produce $PKG_NAME"

# ── The integrity manifest (PHASE-5 T6B) ──
# Computed here, on the bytes that will be uploaded, and re-checked below so a
# dry run proves the manifest is real rather than merely written.
step "Writing $SHA_NAME"
( cd "$DIST" && shasum -a 256 "$ZIP_NAME" > "$SHA_NAME" )
[ -s "$DIST/$SHA_NAME" ] || fail "Failed to write $SHA_NAME"
( cd "$DIST" && shasum -a 256 -c "$SHA_NAME" >/dev/null ) || fail "$SHA_NAME does not match $ZIP_NAME"
echo "  ✓ $SHA_NAME written and self-checked"

# ── Verify the embedded version (the self-updater reads this) ──
step "Verifying embedded version inside $ZIP_NAME"
EMBEDDED="$(unzip -p "$DIST/$ZIP_NAME" dojo-platform/platform/package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")"
[ "$EMBEDDED" = "$VERSION" ] || fail "Zip embeds version '$EMBEDDED', expected '$VERSION'"
echo "  ✓ zip embeds $VERSION"

# ── Smoke-boot the packaged build ──
# v3.1.10-preflight.1 shipped a build that crashed on startup: a runtime import
# of @dojo/shared could not resolve because the package's manifest pointed at
# .ts source that the package does not ship. typecheck and tsx-dev both passed;
# only the compiled, packaged artifact failed. So boot the actual artifact the
# way production does (unzip → npm install → node dist) and refuse to publish if
# it can't reach startup. Runs in --dry-run too, so it's a real preflight gate.
step "Smoke-booting the packaged build (catches non-resolvable imports before publish)"
SMOKE_DIR="$(mktemp -d)"   # torn down by cleanup(), the one EXIT trap
unzip -q "$DIST/$ZIP_NAME" -d "$SMOKE_DIR" || fail "Smoke boot: could not unzip the package"
SMOKE_PLATFORM="$SMOKE_DIR/dojo-platform/platform"
( cd "$SMOKE_PLATFORM" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || fail "Smoke boot: npm install failed in the packaged build"
SMOKE_HOME="$SMOKE_DIR/home"; mkdir -p "$SMOKE_HOME/.dojo/data"
SMOKE_LOG="$SMOKE_DIR/boot.log"
# PHASE-0 T13: the smoke server gets its OWN free port, and "booted" now means
# it ANSWERED, not that a hopeful line appeared in a log.
#
# It used to run on the default 3001 and count the string "is in use" as proof
# of boot — which on a developer box (where the dev server holds 3001) meant the
# packaged build never actually listened and the gate passed on the fact that it
# could not start. The whole point of this step is that only the packaged
# artifact can catch a packaging defect, so it has to really run. A free port
# also lets the upgrade-header auth gate below interrogate the ARTIFACT rather
# than the working tree.
SMOKE_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p));});')"
[ -n "$SMOKE_PORT" ] || fail "Smoke boot: could not obtain a free port for the packaged build. NOT publishing."
# DOJO_SKIP_SYSTEM_DEPS keeps the boot from invoking Homebrew. `exec` makes the
# subshell BECOME node, so $! is node's own PID — killing it actually stops the
# server (which otherwise loops retrying the port forever and would leak).
( cd "$SMOKE_PLATFORM" && HOME="$SMOKE_HOME" DOJO_DATA_DIR="$SMOKE_HOME/.dojo/data" \
    DOJO_PORT="$SMOKE_PORT" DOJO_SKIP_SYSTEM_DEPS=1 NODE_ENV=production exec node packages/server/dist/index.js ) \
    >"$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!   # cleanup() kills it on ANY exit path, not just the happy one
SMOKE_DOJO_LOG="$SMOKE_HOME/.dojo/logs/dojo.log"
booted=0
for _ in $(seq 1 60); do
  # An HTTP answer on its own port is the whole import graph resolved, the
  # migrations run, and the listener up — which is exactly what preflight.1
  # failed to do, and exactly what a log line cannot prove.
  if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$SMOKE_PORT/api/health" 2>/dev/null; then booted=1; break; fi
  kill -0 "$SMOKE_PID" 2>/dev/null || break   # process died before reaching startup
  sleep 1
done
if grep -qiE "ERR_MODULE_NOT_FOUND|Cannot find package|ERR_REQUIRE_ESM|ERR_PACKAGE_PATH_NOT_EXPORTED" \
     "$SMOKE_DOJO_LOG" "$SMOKE_LOG" 2>/dev/null; then
  echo "  ---- last boot output ----"; tail -20 "$SMOKE_LOG" 2>/dev/null
  fail "Smoke boot: packaged build has a module-resolution error (see above). NOT publishing."
fi
[ "$booted" = "1" ] || {
  echo "  ---- last boot output ----"; tail -20 "$SMOKE_LOG" 2>/dev/null
  tail -20 "$SMOKE_DOJO_LOG" 2>/dev/null
  fail "Smoke boot: packaged build did not answer /api/health on :$SMOKE_PORT within 60s. NOT publishing."
}
echo "  ✓ packaged build boots and answers on :$SMOKE_PORT — import graph resolves, migrations run, listener up"

# ── Blocking gate `upgrade-bypass`, declared post-smoke in gate-manifest.mjs ──
# Until 2026-07-26 the auth middleware returned next() for ANY request whose
# `Upgrade` header said `websocket`, before reading a token, across the whole
# /api/* mount — an unauthenticated GET /api/agents came back 200. The exemption
# is now scoped to the three real WS endpoints by PATH, and this is the
# regression gate. It uses a RAW SOCKET because undici/fetch silently refuse to
# send an Upgrade header, so a fetch-based version passes against the vulnerable
# build too — do not "simplify" it.
#
# It asks the PACKAGED ARTIFACT just smoke-booted above, not the working tree:
# the compiled thing being shipped is what a user runs. --require-live turns the
# offline SKIP (correct for `npm run gates`) into a failure, because a release
# that could not ask the question must not answer it.
step "Upgrade-header auth-bypass gate (asked of the packaged artifact, live)"
node "$SCRIPT_DIR/checks/check-upgrade-bypass.mjs" "$SMOKE_PORT" --require-live \
  || fail "Upgrade-header auth-bypass gate: the packaged build let an untokened request through, or no server answered. NOT publishing."

# ── Blocking gate `shipped-souls`, declared post-smoke in gate-manifest.mjs ──
# W24 and W25 measured the PM and the Trainer running the in-code STUB on a live
# box while thousands of bytes of shipped doctrine reached no model anywhere. The
# repair made the assembler resolve `templates/*-SOUL.md` out of the payload — so
# it rests entirely on build-package.sh:69-71 copying those files to where the
# COMPILED module looks. W35 proved that by replaying an install BY HAND and said
# out loud that no gate checks it. This is that gate: it asks the unzipped
# PACKAGED ARTIFACT, recomputing the assembler's own relative hop rather than
# trusting the script text, and --require-artifact refuses a skip.
step "Shipped-souls gate (the built artifact carries templates/*-SOUL.md AND src/tools/docs/*.md where the code looks)"
node "$SCRIPT_DIR/checks/check-shipped-souls.mjs" "$SMOKE_PLATFORM" --require-artifact \
  || fail "Shipped-souls gate: the packaged build is missing a soul template or a TOOL MANUAL, or ships one the compiled assembler / doc reader cannot resolve. NOT publishing. (Which one it is: read the gate's own output — it names the file and the directory it looked in.)"

# ── Blocking gate `shipped-tool-docs`, declared post-smoke in gate-manifest.mjs ──
# The installed-box audit's cheap gate-side close. The doc generator writes one
# `~/.dojo/tools/<tool>.md` per registered tool at boot and counted only its
# SUCCESSES — so a box whose docs directory was not writable logged warn lines,
# reported `count: 0`, and served the previous version's manuals for ever. A stale
# manual reads exactly like a current one, so nothing surfaced.
#
# The smoke boot above already ran the shipped artifact against $SMOKE_HOME, which
# means the answer is sitting right here and has never been asked for. This gate asks
# it twice over: the boot's OWN arithmetic (`/api/health` → `data.toolDocs`, the same
# numbers the owner's Vitals card renders) and an independent count of the `.md`
# files in that sandbox HOME — with the directory the runtime NAMES asserted to be
# that sandbox, because a gate that counted the developer's own ~/.dojo/tools would
# pass every time while measuring nothing. --require-boot turns the offline SKIP
# (correct for `npm run gates`) into a failure.
step "Shipped tool-docs gate (the boot wrote every manual the registry owed)"
node "$SCRIPT_DIR/checks/check-shipped-tool-docs.mjs" "$SMOKE_HOME" "$SMOKE_PORT" --require-boot \
  || fail "Shipped tool-docs gate: the packaged build booted and did not write every tool manual its own registry declares, or could not say whether it had. Agents on that build would read the PREVIOUS version's instructions, which look exactly like current ones. NOT publishing."

# The smoke server has now answered every question we have for it. Stop it
# BEFORE the prefix-determinism gate below, which opens the same sandbox
# database from a second process; the trap above is the backstop, not the plan.
kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true

# ── Cacheable-prefix determinism gate (C28 Part 3) ──
# The prompt cache erodes silently when a volatile token creeps into the cached
# system prefix (a one-token change breaks caching and nothing fails). Assemble
# the stable prefix TWICE from the PACKAGED dist and refuse to publish if it is
# not byte-identical / smell-free / has a non-empty systemVolatile lane. Reuses
# the smoke sandbox (migrations already ran, a primary agent exists). Runs in
# --dry-run too, so it's a real preflight gate.
step "Cacheable-prefix determinism gate (C28)"
( cd "$SMOKE_PLATFORM" && HOME="$SMOKE_HOME" DOJO_DATA_DIR="$SMOKE_HOME/.dojo/data" \
    DOJO_SKIP_SYSTEM_DEPS=1 NODE_ENV=production \
    node "$SCRIPT_DIR/check-prefix-determinism.mjs" "$SMOKE_PLATFORM/packages/server/dist" ) \
  || fail "Cacheable-prefix determinism gate: a cache-breaker is in the system prefix. NOT publishing."

# ── Tool-list conformance gate (2026-07-08 defect-class tripwire) ──
# A whole defect class: hand-maintained lists/maps of tool NAMES that freeze a
# snapshot of the tool surface and silently drift as tools ship (every _ms
# variant, user_ twin, office/onedrive tool falls out). It bit prod, a close-out
# list missed calendar_create_ms and a finished job ghost-re-announced 100 min
# later; drifted google validator maps left drive_upload + sheets_append 100%
# dead. This gate reads the freshly-BUILT dist (npm run build:package above ran
# tsc into packages/{shared,server}/dist) and refuses to publish if any surviving
# hand list names a nonexistent tool OR the derived classifications regress. It is
# CHEAP and static, so it runs OUTSIDE the behavioral conditional, on EVERY cut
# including --skip-behavioral-gate; it is never skippable. It never imports
# agent/tools.ts (module-init circular import), only categories + leaf hand-list
# modules + @dojo/shared.
step "Tool-list conformance gate (hand lists vs. real tool surface)"
node "$SCRIPT_DIR/check-tool-conformance.mjs" \
  || fail "Tool-list conformance gate: a tool-name list drifted from the real tool surface. NOT publishing."

# ── Unit-suite gate (2026-07-21, owner ruling: suites in no gate rot silently) ──
# Every prior era proved it: 8 suites sat red for up to 8 weeks (one carried a
# real production bug, weekend reminder fires) because nothing ever ran them.
# The full server vitest suite now runs on EVERY cut, instruments-clean, and a
# single red refuses the release. It is never skippable; --skip-behavioral-gate
# does not skip this (unit tests are fast; there is no excuse).
#
# PHASE-0 T13 verified this was already wired and left it exactly where it is —
# the plan's accumulated item #3 asked the question ("does the unit suite run in
# release.sh at all?"); the answer is yes, since 2026-07-21, and it is
# unconditional. The router-selector guard (T7) rides in here, so anything that
# makes model selection slow or routes it through a network call stops a release.
step "Unit-suite gate (server + dashboard vitest, full run)"
( cd "$SCRIPT_DIR/../packages/server" && npx vitest run --reporter=dot ) \
  || fail "Unit-suite gate: server unit tests are red. Root-cause and fix (owner rule: testing exists to find problems); NOT publishing."
( cd "$SCRIPT_DIR/../packages/dashboard" && npx vitest run --reporter=dot ) \
  || fail "Unit-suite gate: DASHBOARD tests are red. Root-cause and fix; NOT publishing."
echo "- unit suite: full server + dashboard vitest runs, green (never skippable)" >> "$RELEASE_RECORD"

# ── Prompt-gate record (Phase 0 T13) ──
# Four kit checks read the live server THROUGH THE DEV INSTRUMENTS —
# check-cache-prefix, check-prompt-inventory, check-steer-delivery,
# check-message-prefix. They can never run inside a release: the instruments
# patch the tree being shipped, and the ship-gate below refuses any artifact
# still carrying them. Before this step, "the cache-prefix gate stays blocking"
# was a sentence people remembered rather than a thing the build read.
#
# So the release READS their recorded result instead. The record is written only
# by `dojo-test-kit/checks/run-prompt-gates.mjs`, from the checks' own exit
# codes, and only when it can name the tree the LISTENING SERVER was executing
# and see the instruments installed. This gate then binds that record to THIS
# release: same sha as HEAD, inside a freshness window, every rostered check
# present, the two gates with no owner pointer green, and the acknowledged reds
# carried through wearing their owners' names rather than counted as passes.
step "Prompt-gate record (cache prefix, prompt inventory, steer delivery, message prefix)"
node "$SCRIPT_DIR/checks/check-prompt-gate-record.mjs" --head "$(git rev-parse HEAD)" \
  || fail "Prompt-gate record: missing, stale, measured another tree, or a blocking prompt gate is red. NOT publishing."
{
  echo ""
  echo "## Prompt gates (recorded — they cannot run inside a release)"
  echo ""
  echo '```'
  node "$SCRIPT_DIR/checks/check-prompt-gate-record.mjs" --head "$(git rev-parse HEAD)" 2>&1
  echo '```'
  echo ""
} >> "$RELEASE_RECORD"

# ── Behavioral suite gate (wave-2 fix loop, 2026-07-03) ──
# Real-model behavioral runs are slow (~25 min) and cannot run inline here, so
# the gate checks for a RECENT full-suite green MARKER written only when every
# scenario passed with zero blocking findings (dojo-test-kit/behavioral/
# results/last-green.json). FA-D4: freshness is only the STALENESS FLOOR. The
# gate must also mean "THIS change set passed," so we now HARD-MATCH the
# marker's gitSha to the current pre-bump HEAD. HEAD is still the change-set
# commit at this point, the version bump above is uncommitted and the release
# commit happens later, and the runner records exactly `git rev-parse HEAD` of
# the platform repo, so an equal-length compare is exact. A change landed after
# the green run ⇒ HEAD moved ⇒ mismatch ⇒ refuse. Run the suite with:
#   (cd ../dojo-test-kit && node behavioral/runner.mjs)
step "Behavioral suite gate (full-suite green marker, <24h AND same HEAD)"
if [ "$SKIP_BEHAVIORAL" = "1" ]; then
  echo "  ⚠⚠⚠ BEHAVIORAL SUITE GATE SKIPPED (--skip-behavioral-gate) ⚠⚠⚠"
  echo "  This build ships WITHOUT a suite-green marker tied to this HEAD."
  echo "  Only valid when the owner explicitly authorized skipping the suite"
  echo "  for THIS push. The skip is recorded in the release notes."
else
# K1 (2026-07-26): the kit lives at the workspace sibling `dojo-test-kit/`
# (the old `dev-test-tools/` path never resolved on this layout, which made
# this gate permanently unpassable and pushed releases toward --skip).
# t112: WHICH sibling is now `resolve_kit`'s single answer rather than a path
# spelled again here — see its header. It refuses loudly if there is no kit.
resolve_kit
echo "  · test kit: $KIT_DIR"
BEHAV_MARKER="$KIT_DIR/behavioral/results/last-green.json"
if [ ! -f "$BEHAV_MARKER" ]; then
  fail "Behavioral gate: no last-green marker at $BEHAV_MARKER. Run the behavioral suite to green first. NOT publishing."
fi
BEHAV_AGE_H=$(node -e "const s=require('fs').statSync('$BEHAV_MARKER');console.log(((Date.now()-s.mtimeMs)/3600000).toFixed(1))")
BEHAV_SHA=$(node -e "try{console.log(require('$BEHAV_MARKER').gitSha||'unknown')}catch{console.log('unreadable')}")
if [ "$(node -e "console.log($BEHAV_AGE_H > 24 ? 1 : 0)")" = "1" ]; then
  fail "Behavioral gate: last-green marker is ${BEHAV_AGE_H}h old (>24h). Re-run the suite to green. NOT publishing."
fi
# FA-D4: SHA match. The marker must carry a readable sha AND it must equal the
# tree we are about to ship, or the "green" tells us nothing about this change.
HEAD_SHA="$(git rev-parse HEAD)"
if [ "$BEHAV_SHA" = "unknown" ] || [ "$BEHAV_SHA" = "unreadable" ] || [ -z "$BEHAV_SHA" ]; then
  fail "Behavioral gate: the last-green marker has no readable gitSha, so it can't be tied to this change set. Re-run the behavioral suite to green. NOT publishing."
fi
if [ "$BEHAV_SHA" != "$HEAD_SHA" ]; then
  fail "Behavioral gate: the suite passed a different tree (marker sha ${BEHAV_SHA:0:8}, current HEAD ${HEAD_SHA:0:8}), a change landed after the green run. Re-run the behavioral suite against this HEAD. NOT publishing."
fi
# K1 (2026-07-26): honesty check. The marker now records strict truth
# (green flag, per-scenario pass ratios, flake markers, known-failing list,
# merge provenance). Refuse anything that isn't a clean, first-class green:
#  - green !== true (covers gate-passes carried by known-failing acks)
#  - any scenario that flaked (HARD retry rescue) or passed by SOFT minority
#  - any known-failing entry at all
#  - a merged marker without provenance
# Markers written by a pre-K1 kit lack these fields entirely and are refused,
# which forces regeneration through the hardened kit. Shipping past a known
# failure is still possible — but only via the loud, recorded --skip flag.
BEHAV_DISHONEST=$(node -e "
const m=require('$BEHAV_MARKER');
const bad=[];
if (m.green !== true) bad.push('green!=true');
const v=m.verdicts;
if (!v || typeof v !== 'object') bad.push('no-verdicts(pre-hardening marker)');
else for (const [id,x] of Object.entries(v)) {
  if (x.flaked) bad.push(id+':flaked');
  if ((x.attempts||0)>0 && (x.passCount||0) < x.attempts) bad.push(id+':'+(x.passCount||0)+'/'+x.attempts);
  if (x.knownFailing) bad.push(id+':known-failing');
}
if (Array.isArray(m.knownFailing) && m.knownFailing.length) bad.push('knownFailing-list('+m.knownFailing.length+')');
if (m.merged && !m.mergedFrom) bad.push('merge-without-provenance');
console.log(bad.join(', '));
")
if [ -n "$BEHAV_DISHONEST" ]; then
  fail "Behavioral gate: marker is not an honest first-class green ($BEHAV_DISHONEST). Fix and re-run the suite — or the owner explicitly authorizes --skip-behavioral-gate. NOT publishing."
fi
# ── The marker must have run on the DECLARED FLOOR MODEL (Phase 0 T6 + T13) ──
# T6 made the kit RECORD which model produced a run; T13 makes the release READ
# it. A battery green says nothing about this build unless you know what answered
# the questions: a run on a frontier model hides exactly the failures the floor
# model is meant to expose, and a marker from before the pin carries no modelId
# at all and cannot be checked. Both are refusals here, because "probably the
# right model" is the belief this whole phase exists to stop shipping on.
FLOOR_MODEL_FILE="$KIT_DIR/behavioral/floor-model.json"
[ -f "$FLOOR_MODEL_FILE" ] \
  || fail "Behavioral gate: no declared floor model at $FLOOR_MODEL_FILE, so the marker's model cannot be checked against anything. NOT publishing."
MODEL_MISMATCH=$(node -e "
const declared = require('$FLOOR_MODEL_FILE');
const marker = require('$BEHAV_MARKER');
const want = declared.modelId;
const got = marker.modelId;
if (!want) { console.log('the floor-model declaration carries no modelId'); }
else if (!got) { console.log('the marker carries NO modelId (a pre-pin run) — it cannot say which model produced the green; re-run the battery on the pinned kit'); }
else if (got !== want) { console.log('the battery ran on ' + got + ', the declared floor model is ' + want + ' (' + (declared.observed && declared.observed.name || '?') + ')'); }
")
if [ -n "$MODEL_MISMATCH" ]; then
  fail "Behavioral gate: $MODEL_MISMATCH. A green on an undeclared model is not evidence about this build. NOT publishing."
fi
# ── The marker must be a RELEASE-RITUAL marker (owner ruling 2026-09-20, REDESIGNED 2026-10-11) ──
#
# THE OWNER'S REDESIGN, verbatim (2026-10-11): "we need to remove the random scenarios run before
# each cut. Instead, I want 5 targeted scenarios against the things being fixed to make sure the
# fixes hold." So the ritual is now ONE proof, five times over: FIVE hand-authored scenarios, each
# aimed at something THIS cut fixes, each run with 3 independent attempts and UNANIMITY required
# (the 2026-09-20 blast discipline, generalised from one scenario to five), all five at ONE dojo
# platform commit. The ten-random generated draw is GONE FROM THE CUT PATH — the generator and the
# kit's `--generated` mode stay for the separate on-demand Real World protocol, and a generated
# marker is refused here BY NAME. The v1 marker shape (blast{} + final{}) is likewise a named
# refusal rather than a silent accept: it is a complete, once-shippable object that proves a ritual
# this project no longer runs, so accepting it would certify a cut against the wrong evidence.
# v3.3.2 shipped under the v1 shape; the first v2 cut is the next one.
# THE HOLE, MEASURED: `grep -c ritual deploy/release.sh` was ZERO. The owner's ruling says every
# cut proves its own fixes held — and the kit does assemble a
# marker that records it (`behavioral/lib/release-ritual.mjs`). But the gate above only ever
# asked "green, fresh, this HEAD, floor model", every one of which an ORDINARY green marker
# satisfies. So a cut with no blast proof and no 10-family draw walked straight through the one
# gate the ruling exists to stand behind, and nothing said the ritual had been skipped.
#
# The kit's own module header names this gate as the second, DELIBERATE copy of its
# `validateReleaseRitualMarker` field checks: the release runs in bash and cannot import ESM
# across the sibling-repo boundary, exactly as BEHAV_DISHONEST and MODEL_MISMATCH above cannot.
# So the fields are re-expressed here, and a product-side clause
# (`packages/server/src/update/__tests__/the-release-demands-the-ritual.test.ts`) drives THIS
# script's block against fixture markers so the copy cannot silently rot into a weaker one. When the
# kit's validator gains a field, this copy owes the same one: `final.drawUnsteered` + `pinnedDraws`
# arrived that way, HOURS after the first replication, and for that window a steered rehearsal draw
# was refused at write time and accepted here, with nothing failing. (Those two fields are now gone
# from both sides with the rest of the ten-random draw — the lesson they taught is why the v1-to-v2
# rewrite moved all four surfaces, this block included, in one change.)
#
# THAT HOLE IS NOW MACHINE-BOUND (2026-10-05): `deploy/checks/check-ritual-parity.mjs`, a blocking
# gate in `npm run gates`, EXTRACTS both this block and BEHAV_DISHONEST above, runs them, imports the
# kit's validator, and refuses when the two disagree about which markers are shippable — one valid
# marker both must accept, one single-clause mutant per clause both must refuse. Deleting, weakening
# or renaming a clause on EITHER side now reds that gate by name. The product-side clause above is
# kept: it drives this block's refusals directly, which is a different question from parity.
#
# ⚠ NOT SELF-SUFFICIENT, AND THAT IS A DEPENDENCY ON ORDER (review C, L3-F5b). This block does NOT
# re-check `green`, `verdicts[].flaked`, the known-failing list or merge provenance — the
# BEHAV_DISHONEST (K1) block ABOVE owns those, and the kit's `validateReleaseRitualMarker` owns them
# too on its side. So a dishonest green is refused here only because K1 already ran. MOVE OR REMOVE K1
# AND THIS GATE STOPS CATCHING IT. The division of labour is deliberate (one copy of each question),
# but it is an ordering contract, so: K1 stays above this block. The parity gate reads the UNION of the
# two blocks for exactly this reason, and reds if either one goes missing or stops being read.
RITUAL_BAD=$(node -e "
const m = require('$BEHAV_MARKER');
const bad = [];
if (m.mode !== 'release-ritual') bad.push('mode=' + JSON.stringify(m.mode) + ' (needs release-ritual)');
if (m.blast !== undefined) bad.push('marker carries the v1 blast{} object - the owner redesign of 2026-10-11 replaced the single blast-radius scenario plus the ten-random draw with FIVE hand-authored targeted scenarios, 3 attempts each, all at one dojo head. A v1 marker is not a weaker v2 marker, it is evidence about a different ritual: re-certify with --targeted <version-tag>');
if (m.final !== undefined) bad.push('marker carries the v1 final{} object (the ten-random generated draw) - that draw was REMOVED from the cut path by the owner redesign of 2026-10-11 and no longer certifies anything. The generator and --generated mode still exist for the on-demand Real World protocol, but a generated run cannot mint a shippable marker: re-certify with --targeted <version-tag>');
if (m.ritualVersion !== 2) bad.push('ritualVersion=' + JSON.stringify(m.ritualVersion) + ' (needs the literal 2; a marker carrying none was written by the pre-redesign kit and is refused rather than read as a v2 marker missing a field)');
if (typeof m.targetedVersion !== 'string' || !m.targetedVersion.trim()) bad.push('targetedVersion missing - the marker cannot say WHICH cut these five scenarios were authored against, and five targeted scenarios are only evidence about the fixes they were aimed at');
const t = m.targeted;
if (!Array.isArray(t)) bad.push('no targeted[] array - the ritual requires 5 hand-authored scenarios aimed at this cut changes, each run 3 times with unanimity');
else {
  if (t.length !== 5) bad.push('targeted[] has ' + t.length + ' entries (needs exactly 5 - the owner number is five scenarios against the things being fixed)');
  var seenRejudged = {};
  var ids = t.map(function (e) { return (e && typeof e === 'object') ? e.id : null; });
  var named = ids.filter(function (x) { return typeof x === 'string' && x.trim(); });
  var distinct = new Set(named).size;
  if (named.length !== t.length || distinct !== named.length) bad.push('targeted[] ids are ' + named.length + ' non-empty / ' + distinct + ' distinct of ' + t.length + ' - the ritual requires five DIFFERENT scenarios; a count alone is satisfiable by five copies of one id (or five entries with no id at all), which is one proof recorded five times');
  t.forEach(function (r, i) {
    var label = (r && typeof r === 'object' && typeof r.id === 'string' && r.id) ? r.id : ('targeted[' + i + ']');
    if (!r || typeof r !== 'object') { bad.push('targeted[' + i + '] is not an object - it records no scenario, no attempts and no head'); return; }
    if (typeof r.id !== 'string' || !r.id.trim()) bad.push('targeted[' + i + '].id missing - which scenario this entry is about is not recorded');
    if (r.attempts !== 3) bad.push(label + ': attempts=' + JSON.stringify(r.attempts) + ' (needs exactly 3 - the standing blast discipline, owner ruling 2026-09-20)');
    if (r.passCount !== 3) bad.push(label + ': passCount=' + JSON.stringify(r.passCount) + ' of the required 3 - unanimity means every attempt passed; a majority, a retry rescue or a short record is not a 3/3');
    if (r.allGreen !== true) bad.push(label + ': allGreen!=true - all 3 attempts of every one of the five must have passed');
    if (typeof r.gitSha !== 'string' || !r.gitSha) bad.push(label + ': gitSha missing - cannot prove this scenario ran at the same commit as the other four');
    else if (m.dojoHead && r.gitSha !== m.dojoHead) bad.push(label + ' ran at ' + String(r.gitSha).slice(0, 8) + ' but the marker dojoHead is ' + String(m.dojoHead).slice(0, 8) + ' - not the same commit (a fix landed between this scenario and the rest, so the five do not certify one build)');
    // v3.4 (owner decision 22): attempts RE-JUDGED from their recording count only under the decision guards - the recording was proven complete by the self-replay at record time, the attempt ran against THIS product commit, no clause the recording held is gone, and the replay is green. Mirror of the kit validateReleaseRitualMarker block; check-ritual-parity binds them.
    if (r.rejudged !== undefined) {
      if (!Array.isArray(r.rejudged)) bad.push(label + ': rejudged is not an array of re-judge records');
      else {
        if (r.rejudged.length > (Number.isInteger(r.attempts) ? r.attempts : 0)) bad.push(label + ': ' + r.rejudged.length + ' re-judged attempts but only ' + r.attempts + ' attempts recorded - a re-judge replaces a run, it cannot add one');
        r.rejudged.forEach(function (j, k) {
          var where = label + ' rejudged[' + k + ']';
          if (!j || typeof j !== 'object') { bad.push(where + ' is not an object'); return; }
          if (typeof j.run !== 'string' || !j.run.trim() || !Number.isInteger(j.attempt)) bad.push(where + ': names no source run and attempt - what the re-judge rests on is not recorded');
          else { var key = j.run + '/' + j.attempt + '/' + (j.scenario || label); if (seenRejudged[key]) bad.push(where + ': the same recording ' + key + ' is counted twice - re-judged attempts must be distinct'); seenRejudged[key] = true; }
          if (j.countable !== true) bad.push(where + ': the record does not say it is countable - every decision-22 guard must hold and the re-judge says so itself');
          if (j.selfReplayAtRecord !== true) bad.push(where + ': the recording was never proven complete - the self-replay at record time did not pass');
          if (j.clausesLost !== 0) bad.push(where + ': ' + JSON.stringify(j.clausesLost) + ' clause(s) the recording held are no longer judged - a judge that stops asking a question is loosening, not fixing');
          if (j.replayedPass !== true) bad.push(where + ': the replayed attempt is not green (it did not pass)');
          if (typeof j.productShaRecorded !== 'string' || !j.productShaRecorded) bad.push(where + ': the recording names no product commit');
          else if (m.dojoHead && j.productShaRecorded !== m.dojoHead) bad.push(where + ': the product changed since the recording - it ran at ' + String(j.productShaRecorded).slice(0, 8) + ' and the marker certifies ' + String(m.dojoHead).slice(0, 8) + ' - a re-judge may change the test only');
          if (typeof j.judgeSourceHashNow !== 'string' || !j.judgeSourceHashNow.trim()) bad.push(where + ': no judge-source hash for the judge that re-judged it - which test change this rests on is not recorded');
        });
      }
    }
  });
}
if (typeof m.dojoHead !== 'string' || !m.dojoHead) bad.push('dojoHead missing');
if (m.gitSha && m.dojoHead && m.gitSha !== m.dojoHead) bad.push('marker.gitSha != marker.dojoHead');
if (m.dojoHead && m.dojoHead !== '$HEAD_SHA') bad.push('dojoHead ' + String(m.dojoHead).slice(0, 8) + ' is not the tree being shipped (' + '$HEAD_SHA'.slice(0, 8) + ')');
if (m.fixesAfterFinalDraw !== false) bad.push('fixesAfterFinalDraw=' + JSON.stringify(m.fixesAfterFinalDraw) + ' (must be the literal false)');
console.log(bad.join(', '));
")
if [ -n "$RITUAL_BAD" ]; then
  fail "Behavioral gate: the marker is not a release-ritual marker ($RITUAL_BAD). The owner's 2026-10-11 redesign requires FIVE hand-authored targeted scenarios aimed at THIS cut's fixes, 3 green attempts each, all at this commit: author them as behavioral/blast/<version-tag>/*.mjs and run \`node behavioral/runner.mjs --targeted <version-tag>\` in $KIT_DIR. The ten-random generated draw is no longer part of the cut path and a mode:'generated' marker can never certify a cut. NOT publishing."
fi
# The ✓ line reports `targeted.length` and each entry's OWN recorded ratio — THE FIELDS THE GATE
# CHECKED — never a separate stored count. v1 learned this the hard way: a marker carrying `n: 3`
# with ten families made this line announce "3 families" about a draw the gate had just accepted as
# ten (review C, L3-F6), so the rule is that the ✓ line may only read what a clause above validated.
echo "  ✓ release ritual proven: $(node -e "const m=require('$BEHAV_MARKER');const t=m.targeted||[];console.log(t.length+' targeted scenarios for '+(m.targetedVersion||'?')+', each '+[...new Set(t.map(r=>(r.passCount||0)+'/'+(r.attempts||0)))].join(' ')+' at '+String(m.dojoHead||'?').slice(0,8))")"
echo "    $(node -e "const m=require('$BEHAV_MARKER');console.log((m.targeted||[]).map(r=>r.id).join(', '))")"
echo "  ✓ battery ran on the declared floor model $(node -e "const d=require('$FLOOR_MODEL_FILE');console.log((d.observed&&d.observed.name||'?')+' ('+d.modelId.slice(0,8)+'…)')")"
echo "  ✓ behavioral suite honest-green ${BEHAV_AGE_H}h ago at this exact HEAD (${HEAD_SHA:0:8})$(node -e "const m=require('$BEHAV_MARKER'); if(m.merged) console.log(' [merged over '+(m.mergedFrom&&m.mergedFrom.runId||'?')+']')")"
{
  echo ""
  echo "## Behavioral battery"
  echo ""
  node -e "
const m=require('$BEHAV_MARKER'), d=require('$FLOOR_MODEL_FILE');
console.log('- marker run: ' + (m.runId||'?') + '  at sha ' + String(m.gitSha||'?').slice(0,8));
console.log('- model:      ' + (m.modelId||'(none)') + '  = declared floor model ' + ((d.observed&&d.observed.name)||'?'));
console.log('- green:      ' + m.green + '   scenarios: ' + Object.keys(m.verdicts||{}).length);
"
  echo ""
} >> "$RELEASE_RECORD"
fi

# ── Dev-instrument ship-gate (C23) ──
# The dev-test-tools harness injects sim-outbound send-capture + /api/dev routes into
# source (tools.ts, model.ts, imessage-bridge.ts, gateway/server.ts). uninstall.mjs
# removes them, but a FORGOTTEN or PARTIAL uninstall would ship them — silently capturing
# real sends, exposing dev-only endpoints, or (worse) leaving the sim-outbound import wired
# while the module is gone, which throws on every tool/model call. Refuse to publish if the
# packaged artifact still references any of them. Mirrors the smoke-boot module-resolution
# gate above.
if grep -raqiE "sim-outbound|/api/dev/|DEV-INSTRUMENTS" "$SMOKE_PLATFORM/packages/server/dist" 2>/dev/null; then
  echo "  ---- offending dev-instrument references in packaged build ----"
  grep -raniE "sim-outbound|/api/dev/|DEV-INSTRUMENTS" "$SMOKE_PLATFORM/packages/server/dist" 2>/dev/null | head -10
  fail "Dev-instrument ship-gate: packaged build still references dev instruments (sim-outbound / /api/dev). Run <dojo-test-kit>/server-instruments/uninstall.mjs (DOJO_TEST_KIT names the one this run resolved), rebuild, and re-run. NOT publishing."
fi
echo "  ✓ no dev instruments (sim-outbound / /api/dev) in packaged build"

# ── Land the release record beside the artifacts ──
# The report tier measured things that would otherwise
# scroll off a terminal. Non-negotiable #7 is explicit that a net-positive phase
# owes an accounting, not a number — an accounting needs the numbers written
# down somewhere a reviewer can open.
RECORD_OUT="$DIST/release-record-$VERSION.md"
cp "$RELEASE_RECORD" "$RECORD_OUT" 2>/dev/null || true
echo ""
echo "  📄 release record: $RECORD_OUT"

# ── Dry run stops here ──
if [ "$DRY_RUN" = "1" ]; then
  step "DRY RUN — reverting the version bump; not committing, pushing, or releasing"
  git checkout -- package.json
  echo "  Would next: commit, tag $TAG, push $BRANCH + tag, create $([ "$PREFLIGHT" = "1" ] && echo 'PRE-')release $TAG with all three assets, then verify."
  echo ""
  echo "✅ Dry run OK — every blocking gate green, report tier recorded. Re-run without --dry-run to release for real."
  exit 0
fi

# ── Release notes ──
PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
NOTES_ARGS=()
if [ -n "$NOTES_FILE" ]; then
  [ -f "$NOTES_FILE" ] || fail "Notes file not found: $NOTES_FILE"
  NOTES_ARGS=(--notes-file "$NOTES_FILE")
elif [ -n "$PREV_TAG" ]; then
  TMP_NOTES="$(mktemp)"
  { echo "Changes since $PREV_TAG:"; echo ""; git log "$PREV_TAG"..HEAD --pretty='- %s'; } > "$TMP_NOTES"
  # Honesty line the skip-flag warning promises: a build cut without the
  # behavioral-suite marker says so on its release page.
  if [ "$SKIP_BEHAVIORAL" = "1" ]; then
    { echo ""; echo "Note: cut with --skip-behavioral-gate (owner-authorized); the behavioral suite was not re-run for this build."; } >> "$TMP_NOTES"
  fi
  NOTES_ARGS=(--notes-file "$TMP_NOTES")
else
  NOTES_ARGS=(--generate-notes)
fi

# ── Commit + tag + push (order preserved; each step idempotent on re-run) ──
# FA-D3: keeping the documented order (commit → tag → push → release), every
# late step below is a no-op when a prior interrupted run already did it, so a
# resumed run finishes the release instead of erroring on the existing tag.
step "Committing, tagging, pushing"
git add package.json
if git diff --cached --quiet; then
  echo "  ↪ package.json bump already committed (re-entry); skipping commit"
else
  git commit -m "release: $TAG" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
fi
COMMITTED=1
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "  ↪ tag $TAG already exists at HEAD (re-entry); skipping tag"
else
  git tag "$TAG"
fi
git push origin "$BRANCH"
# Idempotent: pushing a tag already identical on the remote is a harmless
# no-op ("Everything up-to-date"); an UNPUSHED tag (a prior run that tagged but
# died before the tag push) gets pushed now.
git push origin "$TAG"
echo "  ✓ pushed $BRANCH + $TAG"

# ── Create the release WITH the assets in the same call (idempotent) ──
# Preflight builds are GitHub pre-releases so Stable's releases/latest ignores
# them; only the Preflight channel picks them up.
PRERELEASE_ARGS=()
[ "$PREFLIGHT" = "1" ] && PRERELEASE_ARGS=(--prerelease)
step "Creating GitHub $([ "$PREFLIGHT" = "1" ] && echo 'pre-')release $TAG with all three assets"
# Note the ${arr[@]+"${arr[@]}"} guards: under `set -u`, macOS bash 3.2 treats
# "${empty[@]}" as an unbound variable and aborts, so expand empty arrays safely.
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  # FA-D3 re-entry: the release row already exists (a prior run created it but
  # the asset upload failed). Ensure BOTH assets are present via an idempotent
  # --clobber upload instead of erroring on the existing release.
  echo "  ↪ release $TAG already exists, re-uploading all three assets (--clobber)"
  gh release upload "$TAG" "$DIST/$ZIP_NAME" "$DIST/$SHA_NAME" "$DIST/$PKG_NAME" --repo "$REPO" --clobber
else
  gh release create "$TAG" "$DIST/$ZIP_NAME" "$DIST/$SHA_NAME" "$DIST/$PKG_NAME" --repo "$REPO" --title "$TAG" ${PRERELEASE_ARGS[@]+"${PRERELEASE_ARGS[@]}"} ${NOTES_ARGS[@]+"${NOTES_ARGS[@]}"}
fi

# ── The guard rail: do not declare victory until the release is verified ──
step "Verifying the published release"
VERIFY_ARGS=("$VERSION")
[ "$PREFLIGHT" = "1" ] && VERIFY_ARGS+=(--preflight)
if ! bash "$SCRIPT_DIR/verify-release.sh" ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"}; then
  fail "Release $TAG was published but FAILED verification (see above). The self-update is NOT safe yet — fix the assets before announcing."
fi

echo ""
echo "✅ Released $TAG — assets present, latest-release + self-update path verified."
echo "   https://github.com/$REPO/releases/tag/$TAG"
