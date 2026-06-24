#!/bin/bash
# ════════════════════════════════════════
# Agent D.O.J.O. — System dependency installer
# ════════════════════════════════════════
#
# Single source of truth for the brew packages DOJO needs but can't
# install via npm. Called from:
#   - install.sh (fresh installs / .pkg reinstalls)
#   - ensure-system-deps.ts at server STARTUP (so updates self-heal on
#     the next launchd reboot, regardless of which version's update.ts
#     shipped the files)
#
# Idempotent: skips anything already installed. Safe to run repeatedly.
#
# Output contract — the TS wrapper parses two machine-readable markers:
#   INSTALLED:<pkg>  emitted once per freshly-installed package
#   FAILED:<pkg>     emitted once per package that failed to install
# Don't change these markers without updating the parser in
# services/ensure-system-deps.ts.

# Note: intentionally NOT using set -e. brew exits non-zero in many
# normal cases (e.g. already-installed), which would kill the script.

# ── PATH for launchd / Terminal contexts ───────────────────────────
# launchd starts with a minimal PATH so brew isn't discoverable.
# Setup-deps.ts uses the same prefix pattern.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$PATH"

if ! command -v brew &>/dev/null; then
    echo "❌ Homebrew not installed. Cannot install system dependencies."
    echo "   Run install.sh first, or install Homebrew manually: https://brew.sh"
    exit 1
fi

# ── Required brew packages ─────────────────────────────────────────
# Add new system deps here as the platform needs them. Comments
# document which DOJO feature each one enables.

REQUIRED_BREW_PACKAGES=(
    whisper-cpp     # Voice mode: speech-to-text (added in v2.6)
)

# ── Install loop ────────────────────────────────────────────────────

INSTALLED_COUNT=0
SKIPPED_COUNT=0
FAILED_COUNT=0

for pkg in "${REQUIRED_BREW_PACKAGES[@]}"; do
    if brew list "$pkg" &>/dev/null; then
        echo "✅ $pkg already installed"
        ((SKIPPED_COUNT++))
        continue
    fi

    echo "📦 Installing $pkg..."
    if brew install "$pkg"; then
        echo "✅ $pkg installed"
        echo "INSTALLED:$pkg"
        ((INSTALLED_COUNT++))
    else
        echo "⚠️  Failed to install $pkg — feature relying on it will be unavailable"
        echo "FAILED:$pkg"
        ((FAILED_COUNT++))
    fi
done

# ── imsg (iMessage CLI: text + attachments) ─────────────────────────
# Not a brew formula — built from source. imsg links PhoneNumberKit, whose
# compiled .bundle MUST sit next to the executable or the binary SIGTRAPs at
# startup on EVERY invocation. So we (a) probe that imsg actually RUNS, not just
# exists — a presence-only check leaves a crash-on-launch binary in place
# forever — and (b) copy the resource bundle alongside the binary, which the
# old install missed (it copied only bin/imsg). Because this script runs at
# every server startup, a broken imsg self-heals on the next reboot/update.
if command -v imsg &>/dev/null && imsg --help &>/dev/null 2>&1; then
    echo "✅ imsg already installed and working"
    ((SKIPPED_COUNT++))
else
    if command -v imsg &>/dev/null; then
        echo "📦 imsg present but not running (likely missing its PhoneNumberKit bundle) — repairing..."
    else
        echo "📦 Installing imsg (iMessage CLI)..."
    fi
    IMSG_OK=0
    if command -v git &>/dev/null; then
        IMSG_BUILD_DIR=$(mktemp -d)
        if git clone --depth 1 https://github.com/steipete/imsg.git "$IMSG_BUILD_DIR" &>/dev/null \
           && (cd "$IMSG_BUILD_DIR" && make build &>/dev/null); then
            # Locate the Swift resource bundle(s) produced by the build.
            IMSG_BUNDLE_DIR=""
            for d in "$IMSG_BUILD_DIR/bin" "$IMSG_BUILD_DIR/.build/release" "$IMSG_BUILD_DIR"/.build/*/release; do
                if ls "$d"/*.bundle &>/dev/null; then IMSG_BUNDLE_DIR="$d"; break; fi
            done
            # Install OVER an existing imsg (repairs in place); else first writable
            # dir, preferring the order the engine probes (/opt/homebrew first).
            IMSG_DEST=""
            if command -v imsg &>/dev/null; then
                CAND="$(dirname "$(command -v imsg)")"
                cp "$IMSG_BUILD_DIR/bin/imsg" "$CAND/imsg" 2>/dev/null && IMSG_DEST="$CAND"
            fi
            if [ -z "$IMSG_DEST" ]; then
                for d in /opt/homebrew/bin /usr/local/bin "$HOME/.dojo/bin"; do
                    mkdir -p "$d" 2>/dev/null || true
                    if cp "$IMSG_BUILD_DIR/bin/imsg" "$d/imsg" 2>/dev/null; then IMSG_DEST="$d"; break; fi
                done
            fi
            if [ -n "$IMSG_DEST" ]; then
                [ -n "$IMSG_BUNDLE_DIR" ] && cp -R "$IMSG_BUNDLE_DIR"/*.bundle "$IMSG_DEST"/ 2>/dev/null
                # Verify the freshly-installed binary actually launches before
                # claiming success — a bundle still missing means it'd SIGTRAP.
                if "$IMSG_DEST/imsg" --help &>/dev/null 2>&1; then
                    echo "✅ imsg installed with resource bundle → $IMSG_DEST"
                    echo "INSTALLED:imsg"
                    ((INSTALLED_COUNT++))
                    IMSG_OK=1
                fi
            fi
        fi
        rm -rf "$IMSG_BUILD_DIR" 2>/dev/null
    fi
    if [ "$IMSG_OK" -ne 1 ]; then
        echo "⚠️  imsg install/repair failed — iMessage attachments unavailable; text still works via the AppleScript fallback"
        echo "FAILED:imsg"
        ((FAILED_COUNT++))
    fi
fi

echo ""
echo "System dependencies: $INSTALLED_COUNT installed, $SKIPPED_COUNT already present, $FAILED_COUNT failed"

# Always exit 0 — a missing optional dep should not abort install/update.
# The feature using it surfaces the error at runtime if it's actually needed.
exit 0
