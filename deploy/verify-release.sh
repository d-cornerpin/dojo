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

# Prerelease-aware "strictly greater": exit 0 iff version $1 ranks strictly
# above $2. Mirrors the engine's compareVersions and release.sh's rank_above
# so the post-publish check matches how a box resolves the newest release.
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

echo "Verifying release $TAG …"

# 1. Release exists. If not, this is a half-made release (FA-D3): a prior run may
#    have pushed the branch + tag but never created a consumable release. Print
#    state-aware repair for BOTH the missing-release and unpushed-tag states.
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
  echo "     bash deploy/release.sh <the same args you used>   # writes proper notes, uploads both assets"
  echo "   Repair (manual, if you must): build, then create the release WITH real notes:"
  echo "     npm run build:package && gh release create $TAG \\"
  echo "       deploy/dist/$ZIP_NAME deploy/dist/$PKG_NAME --repo $REPO --title $TAG \\"
  echo "       $([ "$PREFLIGHT" = "1" ] && echo '--prerelease ')--notes-file <notes>"
  echo "   then re-run: bash deploy/verify-release.sh $VERSION$([ "$PREFLIGHT" = "1" ] && echo ' --preflight')"
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
  # FA-D2: a preflight tag MUST rank strictly above current stable or every
  # Preflight box treats stable as newer, installs it, and silently drops the
  # feature under test, while the release still looks fine. release.sh now
  # guards this pre-publish; verify it POST-publish too (defense in depth, and
  # this catches a hand-made release that bypassed release.sh).
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
  echo "   If assets are missing: npm run build:package && gh release upload $TAG \\"
  echo "             deploy/dist/$ZIP_NAME deploy/dist/$PKG_NAME --repo $REPO --clobber"
  echo "   If notes are missing:  gh release edit $TAG --repo $REPO --notes-file <file>"
  if [ "$PREFLIGHT" = "1" ]; then
    echo "   If it does NOT rank above stable, or is NOT a pre-release: an --clobber can't"
    echo "     fix this, the base was wrong. Delete this release + tag and re-cut with a"
    echo "     base at least one patch above stable (or run 'release.sh --preflight' with no base)."
  fi
  echo "   then re-run: bash deploy/verify-release.sh $VERSION$([ "$PREFLIGHT" = "1" ] && echo ' --preflight')"
  exit 1
fi
