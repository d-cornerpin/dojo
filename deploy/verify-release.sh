#!/bin/bash
set -uo pipefail

# ════════════════════════════════════════════════════════════════════════
# Verify a DOJO release is COMPLETE and the self-update will work.
#
# Read-only. Checks the four things that have to be true or every user's
# self-update breaks:
#   1. the release exists
#   2. all three assets (dojo-platform.zip + Agent-DOJO-Installer.pkg + dojo-platform.zip.sha256) are uploaded and the .sha256 matches the zip
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
SHA_NAME="dojo-platform.zip.sha256"

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

# Exit 0 iff version $1 ranks strictly above $2, in the order a box resolves releases.
rank_above() { node "$SCRIPT_DIR/version-rank.mjs" --above "$1" "$2"; }

echo "Verifying release $TAG …"

# 1. Release exists. If not, a prior run may have pushed the branch and tag but never created the
#    release; the repair printed depends on whether the tag is on the remote.
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "  ❌ release $TAG does not exist on GitHub"
  echo ""
  echo "❌ $TAG is NOT a consumable release, a box on this channel has nothing to update to."
  if gh api "repos/$REPO/git/refs/tags/$TAG" >/dev/null 2>&1; then
    echo "   State: tag $TAG IS pushed, but the release was never created (a prior run"
    echo "          likely died at 'gh release create')."
  else
    echo "   State: tag $TAG is NOT on the remote either, nothing was pushed."
  fi
  echo "   Repair (preferred, re-run; the late steps are idempotent and RESUME):"
  echo "     bash deploy/release.sh <the same args you used>   # writes proper notes, uploads all three assets"
  echo "   Repair (manual, if you must): build, then create the release WITH real notes:"
  echo "     npm run build:package && gh release create $TAG \\"
  echo "       deploy/dist/$ZIP_NAME deploy/dist/$PKG_NAME deploy/dist/$SHA_NAME --repo $REPO --title $TAG \\"
  echo "       $([ "$PREFLIGHT" = "1" ] && echo '--prerelease ')--notes-file <notes>"
  echo "   then re-run: bash deploy/verify-release.sh $VERSION$([ "$PREFLIGHT" = "1" ] && echo ' --preflight')"
  exit 1
fi

# 2. Both assets present and fully uploaded
ASSETS="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[] | "\(.name):\(.state)"' 2>/dev/null || true)"
have_sha=0
for name in "$ZIP_NAME" "$PKG_NAME" "$SHA_NAME"; do
  if printf '%s\n' "$ASSETS" | grep -qx "$name:uploaded"; then
    note "✓ asset present: $name"
    [ "$name" = "$SHA_NAME" ] && have_sha=1
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
  # A preflight tag must rank above current stable, or every Preflight box takes stable instead.
  LATEST_STABLE="$(gh api "repos/$REPO/releases/latest" --jq '.tag_name' 2>/dev/null | sed 's/^v//' || true)"
  if echo "$LATEST_STABLE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    if rank_above "$VERSION" "$LATEST_STABLE"; then
      note "✓ $TAG ranks above current stable $LATEST_STABLE (Preflight boxes will take it)"
    else
      bad "$TAG does NOT rank above current stable $LATEST_STABLE, every Preflight box would ignore it and stay on stable, dropping the feature under test"
    fi
  else
    note "… could not read latest stable to rank-check (got '${LATEST_STABLE:-none}'); skipping rank check"
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

# The integrity manifest must match the zip — the self-updater refuses an update
# whose manifest does not match (artifact-integrity.ts), and a missing manifest
# makes it proceed silently unverified. Runs only when the manifest was uploaded.
if [ "$have_sha" = "1" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if ! curl -sL -f -o "$TMP/$SHA_NAME" "https://github.com/$REPO/releases/download/$TAG/$SHA_NAME" || \
     ! curl -sL -f -o "$TMP/$ZIP_NAME" "https://github.com/$REPO/releases/download/$TAG/$ZIP_NAME"; then
    bad "could not download $SHA_NAME or $ZIP_NAME to check them against each other"
  else
    manifest_digest="$(grep -Eo '[0-9a-fA-F]{64}' "$TMP/$SHA_NAME" | head -1 | tr 'A-F' 'a-f')"
    zip_digest="$(shasum -a 256 "$TMP/$ZIP_NAME" | cut -d' ' -f1)"
    if [ -n "$manifest_digest" ] && [ "$manifest_digest" = "$zip_digest" ]; then
      note "✓ integrity manifest matches the zip (sha256 ${zip_digest:0:12}…)"
    else
      bad "integrity manifest does not match the zip (manifest: ${manifest_digest:-none}, zip: ${zip_digest:0:12}…). Boxes refuse to install an update whose manifest does not match."
    fi
  fi
fi

# 5. Release notes are present. We ALWAYS ship notes. A bare GitHub
#    "**Full Changelog**" auto-link or an empty body does NOT count — strip
#    those and require something real to remain.
BODY="$(gh release view "$TAG" --repo "$REPO" --json body --jq '.body' 2>/dev/null || true)"
MEAT="$(printf '%s\n' "$BODY" | grep -vE '^[[:space:]]*$|^\*\*Full Changelog\*\*' || true)"
if [ -n "$MEAT" ]; then
  note "✓ release notes present"
else
  bad "release has NO notes (empty body or only an auto changelog link) — add notes with: gh release edit $TAG --notes-file <file>"
fi

echo ""
if [ "$ok" = "1" ]; then
  echo "✅ $TAG is a complete release — self-update will work."
  exit 0
else
  echo "❌ $TAG is INCOMPLETE — self-update is broken until this is fixed."
  echo "   The manifest is written by release.sh:  ( cd deploy/dist && shasum -a 256 $ZIP_NAME > $SHA_NAME )"
  echo "   If assets are missing: npm run build:package && gh release upload $TAG \\"
  echo "             deploy/dist/$ZIP_NAME deploy/dist/$PKG_NAME deploy/dist/$SHA_NAME --repo $REPO --clobber"
  echo "   If notes are missing:  gh release edit $TAG --repo $REPO --notes-file <file>"
  if [ "$PREFLIGHT" = "1" ]; then
    echo "   If it does NOT rank above stable, or is NOT a pre-release: an --clobber can't"
    echo "     fix this, the base was wrong. Delete this release + tag and re-cut with a"
    echo "     base at least one patch above stable (or run 'release.sh --preflight' with no base)."
  fi
  echo "   then re-run: bash deploy/verify-release.sh $VERSION$([ "$PREFLIGHT" = "1" ] && echo ' --preflight')"
  exit 1
fi
