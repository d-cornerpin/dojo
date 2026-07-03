#!/bin/bash
set -euo pipefail

# ════════════════════════════════════════════════════════════════════════
# DOJO release — one command, fully verified.
#
# Cuts a release end-to-end and REFUSES to report success unless the GitHub
# release actually carries both assets and the self-update path resolves.
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$SCRIPT_DIR/dist"

DRY_RUN=0
PREFLIGHT=0
NOTES_FILE=""
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --preflight) PREFLIGHT=1; shift ;;
    --notes-file) NOTES_FILE="${2:-}"; shift 2 ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) VERSION="$1"; shift ;;
  esac
done

fail() { echo "" >&2; echo "❌ $*" >&2; exit 1; }
step() { echo ""; echo "▶ $*"; }

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
  # Auto-pick the base when not given: latest stable + 1 patch. Preflight must
  # always sit ABOVE current stable, or a Preflight box would treat the equal/
  # lower stable as newer and silently drop the test feature.
  if [ -z "$BASE" ]; then
    LATEST_STABLE="$(gh api "repos/$REPO/releases/latest" --jq '.tag_name' 2>/dev/null | sed 's/^v//')"
    echo "$LATEST_STABLE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "Could not read latest stable release to compute the preflight base (got '${LATEST_STABLE:-none}')."
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
else
  VERSION="$BASE"
  TAG="v$VERSION"
  # Stable must strictly increase over the installed stable version.
  if ! node -e "const a='$VERSION'.split('.').map(Number),b='$CURRENT'.replace(/-.*/,'').split('.').map(Number);for(let i=0;i<3;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1)}process.exit(1)"; then
    fail "New version $VERSION must be greater than current $CURRENT"
  fi
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then fail "Tag $TAG already exists locally"; fi
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then fail "Release $TAG already exists on GitHub"; fi
echo "  ✓ on $BRANCH, clean tree, gh authed, $CHANNEL_LABEL, $CURRENT → $VERSION, tag $TAG free"

# ── Typecheck (a broken build must never ship) ──
step "Typecheck"
npm run typecheck
( cd packages/dashboard && npx tsc --noEmit -p tsconfig.json )
echo "  ✓ server, shared, dashboard typecheck clean"

# ── Bump version ──
step "Bumping root package.json → $VERSION"
node -e "const f='package.json',p=require('./'+f);p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"

# ── Build the deploy package ──
step "Building deploy package (this compiles everything)"
npm run build:package
[ -f "$DIST/$ZIP_NAME" ] || fail "Build did not produce $ZIP_NAME"
[ -f "$DIST/$PKG_NAME" ] || fail "Build did not produce $PKG_NAME"

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
SMOKE_DIR="$(mktemp -d)"
trap 'rm -rf "$SMOKE_DIR"' EXIT
unzip -q "$DIST/$ZIP_NAME" -d "$SMOKE_DIR" || fail "Smoke boot: could not unzip the package"
SMOKE_PLATFORM="$SMOKE_DIR/dojo-platform/platform"
( cd "$SMOKE_PLATFORM" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || fail "Smoke boot: npm install failed in the packaged build"
SMOKE_HOME="$SMOKE_DIR/home"; mkdir -p "$SMOKE_HOME/.dojo/data"
SMOKE_LOG="$SMOKE_DIR/boot.log"
# DOJO_SKIP_SYSTEM_DEPS keeps the boot from invoking Homebrew. `exec` makes the
# subshell BECOME node, so $! is node's own PID — killing it actually stops the
# server (which otherwise loops retrying the port forever and would leak).
( cd "$SMOKE_PLATFORM" && HOME="$SMOKE_HOME" DOJO_DATA_DIR="$SMOKE_HOME/.dojo/data" \
    DOJO_SKIP_SYSTEM_DEPS=1 NODE_ENV=production exec node packages/server/dist/index.js ) \
    >"$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
SMOKE_DOJO_LOG="$SMOKE_HOME/.dojo/logs/dojo.log"
booted=0
for _ in $(seq 1 40); do
  # Reaching migrations or the port-bind stage means the whole import graph
  # resolved — which is exactly what preflight.1 failed to do.
  if grep -qiE "Running database migrations|Migration applied|is in use|server (listening|started)|listening on" \
       "$SMOKE_DOJO_LOG" "$SMOKE_LOG" 2>/dev/null; then booted=1; break; fi
  kill -0 "$SMOKE_PID" 2>/dev/null || break   # process died before reaching startup
  sleep 1
done
kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true
if grep -qiE "ERR_MODULE_NOT_FOUND|Cannot find package|ERR_REQUIRE_ESM|ERR_PACKAGE_PATH_NOT_EXPORTED" \
     "$SMOKE_DOJO_LOG" "$SMOKE_LOG" 2>/dev/null; then
  echo "  ---- last boot output ----"; tail -20 "$SMOKE_LOG" 2>/dev/null
  fail "Smoke boot: packaged build has a module-resolution error (see above). NOT publishing."
fi
[ "$booted" = "1" ] || {
  echo "  ---- last boot output ----"; tail -20 "$SMOKE_LOG" 2>/dev/null
  fail "Smoke boot: packaged build did not reach startup within 40s. NOT publishing."
}
echo "  ✓ packaged build boots — import graph resolves and migrations run"

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

# ── Behavioral suite gate (wave-2 fix loop, 2026-07-03) ──
# Real-model behavioral runs are slow (~25 min) and cannot run inline here, so
# the gate checks for a RECENT full-suite green MARKER written only when every
# scenario passed with zero blocking findings (dev-test-tools/behavioral/
# results/last-green.json). Tradeoff stated plainly: the marker's git SHA is
# logged for the human but not hard-matched, because the release commit itself
# (and the instrument uninstall) legitimately change the SHA after the green
# run. Freshness is the enforced bar: a marker older than 24h means the suite
# was not run against this change set. Run it with:
#   (cd ../dev-test-tools && node behavioral/runner.mjs)
step "Behavioral suite gate (full-suite green marker, <24h)"
BEHAV_MARKER="$SCRIPT_DIR/../../dev-test-tools/behavioral/results/last-green.json"
if [ ! -f "$BEHAV_MARKER" ]; then
  fail "Behavioral gate: no last-green marker. Run the behavioral suite to green first. NOT publishing."
fi
BEHAV_AGE_H=$(node -e "const s=require('fs').statSync('$BEHAV_MARKER');console.log(((Date.now()-s.mtimeMs)/3600000).toFixed(1))")
BEHAV_SHA=$(node -e "try{console.log(require('$BEHAV_MARKER').gitSha||'unknown')}catch{console.log('unreadable')}")
if [ "$(node -e "console.log($BEHAV_AGE_H > 24 ? 1 : 0)")" = "1" ]; then
  fail "Behavioral gate: last-green marker is ${BEHAV_AGE_H}h old (>24h). Re-run the suite to green. NOT publishing."
fi
echo "  ✓ behavioral suite green ${BEHAV_AGE_H}h ago (marker sha ${BEHAV_SHA:0:8}; verify it reflects this change set)"

# ── Dev-instrument ship-gate (C23) ──
# The dev-test-tools harness injects sim-outbound send-capture + /api/dev routes into
# source (tools.ts, model.ts, imessage-bridge.ts, gateway/server.ts). uninstall.mjs
# removes them, but a FORGOTTEN or PARTIAL uninstall would ship them — silently capturing
# real sends, exposing dev-only endpoints, or (worse) leaving the sim-outbound import wired
# while the module is gone, which throws on every tool/model call. Refuse to publish if the
# packaged artifact still references any of them. Mirrors the smoke-boot module-resolution
# gate above.
if grep -rqiE "sim-outbound|/api/dev/|DEV-INSTRUMENTS" "$SMOKE_PLATFORM/packages/server/dist" 2>/dev/null; then
  echo "  ---- offending dev-instrument references in packaged build ----"
  grep -rniE "sim-outbound|/api/dev/|DEV-INSTRUMENTS" "$SMOKE_PLATFORM/packages/server/dist" 2>/dev/null | head -10
  fail "Dev-instrument ship-gate: packaged build still references dev instruments (sim-outbound / /api/dev). Run dev-test-tools/server-instruments/uninstall.mjs, rebuild, and re-run. NOT publishing."
fi
echo "  ✓ no dev instruments (sim-outbound / /api/dev) in packaged build"

# ── Dry run stops here ──
if [ "$DRY_RUN" = "1" ]; then
  step "DRY RUN — reverting the version bump; not committing, pushing, or releasing"
  git checkout -- package.json
  echo "  Would next: commit, tag $TAG, push $BRANCH + tag, create $([ "$PREFLIGHT" = "1" ] && echo 'PRE-')release $TAG with both assets, then verify."
  echo ""
  echo "✅ Dry run OK. Re-run without --dry-run to release for real."
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
  NOTES_ARGS=(--notes-file "$TMP_NOTES")
else
  NOTES_ARGS=(--generate-notes)
fi

# ── Commit + tag + push ──
step "Committing, tagging, pushing"
git add package.json
git commit -m "release: $TAG" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "  ✓ pushed $BRANCH + $TAG"

# ── Create the release WITH the assets in the same call ──
# Preflight builds are GitHub pre-releases so Stable's releases/latest ignores
# them; only the Preflight channel picks them up.
PRERELEASE_ARGS=()
[ "$PREFLIGHT" = "1" ] && PRERELEASE_ARGS=(--prerelease)
step "Creating GitHub $([ "$PREFLIGHT" = "1" ] && echo 'pre-')release $TAG with both assets"
# Note the ${arr[@]+"${arr[@]}"} guards: under `set -u`, macOS bash 3.2 treats
# "${empty[@]}" as an unbound variable and aborts, so expand empty arrays safely.
gh release create "$TAG" "$DIST/$ZIP_NAME" "$DIST/$PKG_NAME" --repo "$REPO" --title "$TAG" ${PRERELEASE_ARGS[@]+"${PRERELEASE_ARGS[@]}"} ${NOTES_ARGS[@]+"${NOTES_ARGS[@]}"}

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
