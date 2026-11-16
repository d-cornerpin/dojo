#!/bin/bash
set -euo pipefail

# ════════════════════════════════════════════════════════════════════════
# DOJO release — one command, fully verified.
#
# Cuts a release end-to-end and REFUSES to report success unless the GitHub
# release actually carries all three assets and the self-update path resolves.
#
# Usage:
#   bash deploy/release.sh <version> --notes-file <path> [--dry-run]
#   e.g.  bash deploy/release.sh 3.0.4 --notes-file notes.md
#         bash deploy/release.sh 3.0.4 --notes-file notes.md --dry-run   # build + verify, no push
#
# --notes-file is REQUIRED (the plain-language notes the rule in deploy/RELEASE.md asks for): a
# release without it is refused before anything is touched. There is no commit-subject fallback.
#
# --dry-run does everything locally (bump, build, verify the embedded version)
# then reverts the bump WITHOUT committing/pushing/releasing. Use it to prove a
# release will go cleanly before doing it for real. Only the flag makes a dry
# run: a DRY_RUN variable in the environment is refused.
# ════════════════════════════════════════════════════════════════════════

REPO="d-cornerpin/dojo"
ZIP_NAME="dojo-platform.zip"
PKG_NAME="Agent-DOJO-Installer.pkg"
# The sha256 manifest the self-updater (update/artifact-integrity.ts) checks the
# zip against: proof the bytes arrived intact, not of who made them.
SHA_NAME="dojo-platform.zip.sha256"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST="$SCRIPT_DIR/dist"

if [ -n "${DRY_RUN+x}" ]; then
  echo "❌ DRY_RUN is set in the environment, and that does not make a dry run. Unset it and pass the --dry-run flag. NOT publishing." >&2
  exit 2
fi
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
    *) [ -z "$VERSION" ] || { echo "❌ A second version was given ($VERSION, then $1): pass one version. NOT publishing." >&2; exit 2; }
       VERSION="$1"; shift ;;
  esac
done

# ── One cleanup path for every way this script can end ──
# A refused, interrupted or killed run leaves the tree as it found it: the version
# bump is reverted while it is uncommitted (once committed it is real), and the
# smoke sandbox is torn down. This is the only EXIT trap.
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

# Exit 0 iff version $1 ranks strictly above every other argument, in the order a box resolves releases.
rank_above() { node "$SCRIPT_DIR/version-rank.mjs" --above "$@"; }

# True iff tag $1 exists locally AND points at the current HEAD commit: a prior
# run committed the bump, pushed the tag, then failed at `gh release create`.
tag_points_at_head() {
  git rev-parse "$1" >/dev/null 2>&1 \
    && [ "$(git rev-parse "$1^{commit}" 2>/dev/null)" = "$(git rev-parse HEAD 2>/dev/null)" ]
}

# Stable needs an explicit X.Y.Z (released as vX.Y.Z from `main`). Preflight
# picks its own number unless given a base, and publishes vX.Y.Z-preflight.N
# from the `Preflight` branch.
# See deploy/RELEASES.md for the full process + numbering rules.
if [ "$PREFLIGHT" = "0" ] && [ -z "$VERSION" ]; then
  fail "Usage: bash deploy/release.sh <X.Y.Z> --notes-file <path> [--dry-run]   (preflight: --preflight [<X.Y.Z>])"
fi
if [ -n "$VERSION" ]; then
  echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "Base version must be X.Y.Z (got: $VERSION)"
fi
BASE="$VERSION"

# ── Plain release notes are required ──
# The notes are what a user reads in Settings before updating; the rule (deploy/RELEASE.md) is
# plain sentences, grouped, no developer words. A commit-subject list is not that, so there is no
# fallback to one: no notes file, or an empty one, is a refusal, before anything is touched. A
# --dry-run says what the real run would say and carries on, so the other gates are still proven.
WOULD_REFUSE=0
NOTES_REFUSAL=""
if [ -z "$NOTES_FILE" ]; then
  NOTES_REFUSAL="Refused: a release needs plain release notes (--notes-file). The rule is in deploy/RELEASE.md. NOT publishing."
elif [ ! -f "$NOTES_FILE" ]; then
  NOTES_REFUSAL="Notes file not found: $NOTES_FILE. NOT publishing."
elif ! grep -q '[^[:space:]]' "$NOTES_FILE"; then
  NOTES_REFUSAL="Refused: a release needs plain release notes (--notes-file). The rule is in deploy/RELEASE.md. NOT publishing. ($NOTES_FILE is empty.)"
fi
if [ -z "$NOTES_REFUSAL" ]; then
  # Absolute, once, before the `cd "$ROOT"` below: a relative path validated here would be read
  # from the wrong directory after it.
  NOTES_FILE="$(cd "$(dirname "$NOTES_FILE")" && pwd)/$(basename "$NOTES_FILE")"
  echo "  ✓ release notes: $NOTES_FILE"
fi
if [ -n "$NOTES_REFUSAL" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "" >&2; echo "❌ WOULD FAIL (dry run): $NOTES_REFUSAL" >&2
    WOULD_REFUSE=1
  else
    fail "$NOTES_REFUSAL"
  fi
fi

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
  # A test build must rank above the latest stable and above every preflight build already out, or the
  # boxes that should take it ignore it. With no base it takes the higher of stable + 1 patch and the
  # newest preflight's base; the ordinal is the next free one for that base.
  LATEST_STABLE="$(gh api "repos/$REPO/releases/latest" --jq '.tag_name' 2>/dev/null | sed 's/^v//')"
  echo "$LATEST_STABLE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || fail "Could not read latest stable release to compute/guard the preflight base (got '${LATEST_STABLE:-none}')."
  LISTED="$(gh release list --repo "$REPO" --limit 100 2>/dev/null)" \
    || fail "Could not read the release list, so the preflight number cannot be checked against what is out."
  RELEASED="$(printf '%s\n' "$LISTED" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+-preflight\.[0-9]+' || true)"
  TOP_PRE="$(node "$SCRIPT_DIR/version-rank.mjs" $RELEASED)"
  if [ -z "$BASE" ]; then
    BASE="$(node "$SCRIPT_DIR/version-rank.mjs" "$(echo "$LATEST_STABLE" | awk -F. '{printf "%d.%d.%d", $1, $2, $3 + 1}')" "${TOP_PRE%-preflight.*}" | sed 's/^v//')"
    echo "  ↪ auto base: latest stable $LATEST_STABLE, newest preflight ${TOP_PRE:-none} → preflight target $BASE"
  fi
  LAST_N="$(printf '%s\n' $RELEASED | grep -E "^v${BASE}-preflight\." | sed -E 's/.*preflight\.//' | sort -n | tail -1 || true)"
  VERSION="${BASE}-preflight.$(( ${LAST_N:-0} + 1 ))"
  TAG="v$VERSION"
  rank_above "$VERSION" "$LATEST_STABLE" ${TOP_PRE:+"$TOP_PRE"} \
    || fail "Preflight $VERSION does NOT rank above everything already out (stable $LATEST_STABLE, newest preflight ${TOP_PRE:-none}), so every Preflight box would ignore it. Run --preflight with no base to pick the number, or give a base at least that high."
  echo "  ✓ $VERSION ranks above current stable $LATEST_STABLE and newest preflight ${TOP_PRE:-none}"
else
  VERSION="$BASE"
  TAG="v$VERSION"
  # Stable must rank above the current version (a pre-release of its own base included), unless this
  # run resumes an interrupted release whose bump is committed and whose tag sits at HEAD.
  if ! tag_points_at_head "$TAG" && ! rank_above "$VERSION" "$CURRENT"; then
    fail "New version $VERSION must be greater than current $CURRENT"
  fi
fi

# Re-entry: a tag already at HEAD means a prior run died after tagging, so this run resumes (every
# late step is idempotent); a tag anywhere else is a conflict.
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
npm run build -w packages/shared   # the server's type check reads the shared package's build
npm run typecheck
echo "  ✓ server, shared, dashboard typecheck clean"

# ── The gate manifest (deploy/checks/gate-manifest.mjs) ──
# The pre-build rows read source, so they run here, before the version bump, per
# this script's "fail before changing anything" rule. The post-smoke rows run
# further down, against the packaged build.

# The release record holds what the report tier printed. Copied into deploy/dist at the end.
RELEASE_RECORD="$(mktemp)"
{
  echo "# Release record — $CHANNEL_LABEL"
  echo ""
  echo "- cut at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- branch: $BRANCH"
  echo "- HEAD:   $(git rev-parse HEAD)"
  echo ""
} > "$RELEASE_RECORD"

# Runs every blocking manifest row of one phase, in order; the first failure refuses
# the release. $1 = phase, $2 = the fewest rows that phase may declare (an emptied
# list would pass every release). A row's args are shell source naming release-time
# values such as "$SMOKE_PORT", hence eval.
run_blocking_gates() {
  local rows total n=0
  rows="$(node "$SCRIPT_DIR/checks/gate-manifest.mjs" --emit blocking "$1")" \
    || fail "Gate manifest: deploy/checks/gate-manifest.mjs could not be read. NOT publishing."
  total="$(printf '%s' "$rows" | grep -c . || true)"
  [ "${total:-0}" -ge "$2" ] \
    || fail "Gate manifest: only ${total:-0} $1 blocking gate(s) declared, fewer than $2. NOT publishing."
  while IFS=$'\x1f' read -r g_id g_script g_args g_title g_fail; do
    [ -n "$g_id" ] || continue
    n=$((n + 1))
    step "Blocking gate ($1) $n/$total: $g_title"
    eval "node \"\$ROOT/\$g_script\" $g_args" </dev/null || fail "$g_fail"
  done <<__GATE_ROWS__
$rows
__GATE_ROWS__
  [ "$n" -eq "$total" ] \
    || fail "Gate manifest: ran $n of $total declared $1 blocking gates. NOT publishing."
  echo ""
  echo "  ✓ $n/$total $1 blocking gates green (declared in deploy/checks/gate-manifest.mjs)"
}
run_blocking_gates pre-build 5

# ── The report tier, read from the same manifest ──
# These print into the release record and never refuse the release.
REPORT_ROWS="$(node "$SCRIPT_DIR/checks/gate-manifest.mjs" --emit report pre-build)" \
  || fail "Gate manifest: the report tier could not be read. NOT publishing."
REPORT_TOTAL="$(printf '%s' "$REPORT_ROWS" | grep -c . || true)"
step "Report tier (${REPORT_TOTAL:-0} checks, recorded into the release record, never blocking)"
{
  echo "## Report tier (never blocking)"
  echo ""
  echo '```'
} >> "$RELEASE_RECORD"
REPORT_N=0
while IFS=$'\x1f' read -r r_id r_script r_args r_title r_fail; do
  [ -n "$r_id" ] || continue
  REPORT_N=$((REPORT_N + 1))
  R_OUT="$(node "$ROOT/$r_script" 2>&1 </dev/null)" && R_RC=0 || R_RC=$?
  {
    echo "── $r_id ──"
    printf '%s\n' "$R_OUT"
    [ "$R_RC" -eq 0 ] || echo "(exit $R_RC, report tier, not blocking)"
    echo ""
  } >> "$RELEASE_RECORD"
  if [ "$R_RC" -eq 0 ]; then echo "  · $r_id: ok (report only)"; else echo "  · $r_id: exit $R_RC (report only, not blocking): $(printf '%s\n' "$R_OUT" | grep -E '✗' | head -1 | cut -c1-160)"; fi
done <<__REPORT_ROWS__
$REPORT_ROWS
__REPORT_ROWS__
echo '```' >> "$RELEASE_RECORD"
echo "" >> "$RELEASE_RECORD"
echo "  ✓ $REPORT_N report-tier check(s) captured into the release record"

# ── Bump version ──
step "Bumping root package.json → $VERSION"
node -e "const f='package.json',p=require('./'+f);p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
BUMPED=1

# ── Build the deploy package ──
step "Building deploy package (this compiles everything)"
npm run build:package
[ -f "$DIST/$ZIP_NAME" ] || fail "Build did not produce $ZIP_NAME"
[ -f "$DIST/$PKG_NAME" ] || fail "Build did not produce $PKG_NAME"

# ── The integrity manifest ──
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
# Boots the packaged artifact the way production does (unzip, npm install, node dist): only
# the compiled package shows a packaging defect such as an import it cannot resolve.
step "Smoke-booting the packaged build (catches non-resolvable imports before publish)"
SMOKE_DIR="$(mktemp -d)"   # torn down by cleanup(), the one EXIT trap
unzip -q "$DIST/$ZIP_NAME" -d "$SMOKE_DIR" || fail "Smoke boot: could not unzip the package"
SMOKE_PLATFORM="$SMOKE_DIR/dojo-platform/platform"
( cd "$SMOKE_PLATFORM" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || fail "Smoke boot: npm install failed in the packaged build"
SMOKE_HOME="$SMOKE_DIR/home"; mkdir -p "$SMOKE_HOME/.dojo/data"
SMOKE_LOG="$SMOKE_DIR/boot.log"
# Its own free port, and "booted" means it answered: the post-smoke gates below ask this artifact.
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
  # A 200 from health means the import graph resolved, the migrations ran and the app serves.
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

# ── The post-smoke manifest rows: asked of the packaged build just booted ──
# Each passes a flag that turns its offline skip into a failure, so a release
# that could not ask the question does not answer it.
run_blocking_gates post-smoke 3

# The smoke server has now answered every question we have for it. Stop it
# BEFORE the prefix-determinism gate below, which opens the same sandbox
# database from a second process; the trap above is the backstop, not the plan.
kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true

# ── Cacheable-prefix determinism gate ──
# Assembles the stable prompt prefix twice from the packaged dist in the smoke sandbox and refuses
# when it differs or carries a cache-breaker.
step "Cacheable-prefix determinism gate"
( cd "$SMOKE_PLATFORM" && HOME="$SMOKE_HOME" DOJO_DATA_DIR="$SMOKE_HOME/.dojo/data" \
    DOJO_SKIP_SYSTEM_DEPS=1 NODE_ENV=production \
    node "$SCRIPT_DIR/check-prefix-determinism.mjs" "$SMOKE_PLATFORM/packages/server/dist" ) \
  || fail "Cacheable-prefix determinism gate: a cache-breaker is in the system prefix. NOT publishing."

# ── Unit-suite gate: every suite on every cut, never skippable ──
step "Unit-suite gate (server + dashboard vitest, the checker tests, full run)"
( cd "$SCRIPT_DIR/../packages/server" && npx vitest run --reporter=dot ) \
  || fail "Unit-suite gate: server unit tests are red. Root-cause and fix (owner rule: testing exists to find problems); NOT publishing."
( cd "$SCRIPT_DIR/../packages/dashboard" && npx vitest run --reporter=dot ) \
  || fail "Unit-suite gate: DASHBOARD tests are red. Root-cause and fix; NOT publishing."
node --test "$SCRIPT_DIR"/checks/__tests__/*.test.mjs \
  || fail "Unit-suite gate: the checker tests in deploy/checks/__tests__ are red. NOT publishing."
echo "- unit suite: full server + dashboard vitest runs and the checker tests, green (never skippable)" >> "$RELEASE_RECORD"

# ── Dev-instrument ship-gate ──
# The dev harness injects send capture and /api/dev routes into source; a forgotten uninstall
# would ship them, so the packaged artifact must reference none of them.
if grep -raqiE "sim-outbound|/api/dev/|DEV-INSTRUMENTS" "$SMOKE_PLATFORM/packages/server/dist" 2>/dev/null; then
  echo "  ---- offending dev-instrument references in packaged build ----"
  grep -raniE "sim-outbound|/api/dev/|DEV-INSTRUMENTS" "$SMOKE_PLATFORM/packages/server/dist" 2>/dev/null | head -10
  fail "Dev-instrument ship-gate: packaged build still references dev instruments (sim-outbound / /api/dev). Run <dojo-test-kit>/server-instruments/uninstall.mjs, rebuild, and re-run. NOT publishing."
fi
echo "  ✓ no dev instruments (sim-outbound / /api/dev) in packaged build"

# ── Land the release record beside the artifacts ──
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
  if [ "$WOULD_REFUSE" = "1" ]; then
    fail "Dry run: every blocking gate is green, but the real run would be REFUSED ($NOTES_REFUSAL)"
  fi
  echo "✅ Dry run OK — every blocking gate green, report tier recorded. Re-run without --dry-run to release for real."
  exit 0
fi

# ── Release notes ──
# The notes file was checked up front (a missing or empty one never gets here).
NOTES_ARGS=(--notes-file "$NOTES_FILE")

# ── Commit + tag + push, in that order; each step is a no-op when a resumed run finds it done ──
step "Committing, tagging, pushing"
git add package.json
if git diff --cached --quiet; then
  echo "  ↪ package.json bump already committed (re-entry); skipping commit"
else
  # The trailer is the neutral identity this repo is configured with (the commit-identity gate
  # refuses a machine-default one), so no model or person is baked into the script.
  RELEASE_IDENTITY="$(git config user.name) <$(git config user.email)>"
  git commit -m "release: $TAG" -m "Co-Authored-By: $RELEASE_IDENTITY"
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
  # Re-entry: the release row exists but an upload failed, so every asset is uploaded again.
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
