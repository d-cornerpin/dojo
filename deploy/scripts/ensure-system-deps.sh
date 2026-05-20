#!/bin/bash
# ════════════════════════════════════════
# Agent D.O.J.O. — System dependency installer
# ════════════════════════════════════════
#
# Single source of truth for the brew packages DOJO needs but can't
# install via npm. Called from install.sh (fresh installs / .pkg
# reinstalls) AND from update.ts (self-update path) so new system deps
# get picked up automatically when a release adds them.
#
# Idempotent: skips anything already installed. Safe to run repeatedly.

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
        ((INSTALLED_COUNT++))
    else
        echo "⚠️  Failed to install $pkg — feature relying on it will be unavailable"
        ((FAILED_COUNT++))
    fi
done

echo ""
echo "System dependencies: $INSTALLED_COUNT installed, $SKIPPED_COUNT already present, $FAILED_COUNT failed"

# Always exit 0 — a missing optional dep should not abort install/update.
# The feature using it surfaces the error at runtime if it's actually needed.
exit 0
