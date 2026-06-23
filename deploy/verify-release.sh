#!/bin/bash
set -uo pipefail

# ════════════════════════════════════════════════════════════════════════
# Verify a DOJO release is COMPLETE and the self-update will work.
#
# Read-only. Checks the four things that have to be true or every user's
# self-update breaks:
#   1. the release exists
#   2. both assets (dojo-platform.zip + Agent-DOJO-Installer.pkg) are uploaded
#   3. releases/latest resolves to this tag (what the updater queries)
#   4. the self-update zip is actually downloadable
#
# Usage:
#   bash deploy/verify-release.sh [<version>]   # defaults to root package.json
#
# Exit 0 = complete; non-zero = incomplete (prints the exact repair command).
# ════════════════════════════════════════════════════════════════════════

REPO="d-cornerpin/dojo"
ZIP_NAME="dojo-platform.zip"
PKG_NAME="Agent-DOJO-Installer.pkg"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PREFLIGHT=0
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --preflight) PREFLIGHT=1; shift ;;
    *) VERSION="$1"; shift ;;
  esac
done
VERSION="${VERSION:-$(node -p "require('$ROOT/package.json').version")}"
TAG="v$VERSION"
ok=1
note() { echo "  $*"; }
bad()  { echo "  ❌ $*"; ok=0; }

echo "Verifying release $TAG …"

# 1. Release exists
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "  ❌ release $TAG does not exist on GitHub"
  echo ""
  echo "❌ $TAG is NOT a release."
  exit 1
fi

# 2. Both assets present and fully uploaded
ASSETS="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[] | "\(.name):\(.state)"' 2>/dev/null || true)"
for name in "$ZIP_NAME" "$PKG_NAME"; do
  if printf '%s\n' "$ASSETS" | grep -qx "$name:uploaded"; then
    note "✓ asset present: $name"
  else
    bad "missing or not-uploaded asset: $name"
  fi
done

# 3. The updater can resolve this tag on its channel.
if [ "$PREFLIGHT" = "1" ]; then
  # Preflight builds MUST be GitHub pre-releases — that's what keeps them out of
  # Stable's releases/latest and visible only to the Preflight channel.
  IS_PRE="$(gh release view "$TAG" --repo "$REPO" --json isPrerelease --jq '.isPrerelease' 2>/dev/null || echo false)"
  if [ "$IS_PRE" = "true" ]; then
    note "✓ $TAG is a pre-release (Preflight channel resolves it; Stable ignores it)"
  else
    bad "$TAG is NOT marked pre-release — it would shadow Stable's releases/latest for everyone"
  fi
else
  # Stable: the self-updater hits /releases/latest, which must resolve to this tag.
  LATEST="$(gh api "repos/$REPO/releases/latest" --jq '.tag_name' 2>/dev/null || true)"
  if [ "$LATEST" = "$TAG" ]; then
    note "✓ releases/latest → $TAG"
  else
    bad "releases/latest is '${LATEST:-none}', not $TAG (a draft/prerelease or a newer tag may be shadowing it)"
  fi
fi

# 4. The self-update zip is actually downloadable (range-GET one byte)
URL="https://github.com/$REPO/releases/download/$TAG/$ZIP_NAME"
CODE="$(curl -sL -o /dev/null -w '%{http_code}' -r 0-0 "$URL" 2>/dev/null || echo 000)"
if [ "$CODE" = "200" ] || [ "$CODE" = "206" ]; then
  note "✓ $ZIP_NAME is downloadable (HTTP $CODE)"
else
  bad "$ZIP_NAME not downloadable (HTTP $CODE) at $URL"
fi

echo ""
if [ "$ok" = "1" ]; then
  echo "✅ $TAG is a complete release — self-update will work."
  exit 0
else
  echo "❌ $TAG is INCOMPLETE — self-update is broken until this is fixed."
  echo "   Repair: npm run build:package && gh release upload $TAG \\"
  echo "             deploy/dist/$ZIP_NAME deploy/dist/$PKG_NAME --repo $REPO --clobber"
  echo "           then re-run: bash deploy/verify-release.sh $VERSION"
  exit 1
fi
