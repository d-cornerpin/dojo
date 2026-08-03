#!/bin/bash
set -e

# ════════════════════════════════════════
# DOJO Platform — Build Deployable Package
# Run this on the development machine
# ════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
OUTPUT_NAME="dojo-platform"

echo "🥋 Building DOJO Platform package..."
echo ""

# Clean previous build
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/$OUTPUT_NAME"

cd "$PROJECT_ROOT"

# Build all packages
echo "📦 Building shared types..."
npm run build -w packages/shared

echo "📦 Building server..."
npm run build -w packages/server

echo "📦 Building dashboard..."
npm run build -w packages/dashboard

# Build watchdog
echo "📦 Building watchdog..."
cd "$PROJECT_ROOT/watchdog"
npx tsc 2>/dev/null || true
cd "$PROJECT_ROOT"

# Assemble package
echo "📋 Assembling package..."

DEST="$DIST_DIR/$OUTPUT_NAME"

# Platform
mkdir -p "$DEST/platform/packages/server"
mkdir -p "$DEST/platform/packages/dashboard"
mkdir -p "$DEST/platform/packages/shared"
cp "$PROJECT_ROOT/package.json" "$DEST/platform/"
cp "$PROJECT_ROOT/package-lock.json" "$DEST/platform/" 2>/dev/null || true
cp -r "$PROJECT_ROOT/packages/server/dist" "$DEST/platform/packages/server/"
cp "$PROJECT_ROOT/packages/server/package.json" "$DEST/platform/packages/server/"
# Copy migrations to where the compiled code expects them (dist/db/migrations)
mkdir -p "$DEST/platform/packages/server/dist/db"
cp -r "$PROJECT_ROOT/packages/server/src/db/migrations" "$DEST/platform/packages/server/dist/db/migrations"
# Copy startup scripts (ensure-system-deps.sh runs on every server boot
# from the platform tree, so it ships with every update).
mkdir -p "$DEST/platform/packages/server/scripts"
cp "$PROJECT_ROOT/packages/server/scripts/ensure-system-deps.sh" "$DEST/platform/packages/server/scripts/"
chmod +x "$DEST/platform/packages/server/scripts/ensure-system-deps.sh"
cp -r "$PROJECT_ROOT/packages/dashboard/dist" "$DEST/platform/packages/dashboard/"
cp "$PROJECT_ROOT/packages/dashboard/package.json" "$DEST/platform/packages/dashboard/"
cp -r "$PROJECT_ROOT/packages/shared/dist" "$DEST/platform/packages/shared/"
# The repo's shared package.json points main/types at ./src/index.ts so dev (tsx)
# and typecheck resolve the live TypeScript. But the package ships only dist/, not
# src/, and production runs compiled node (which cannot import a .ts file). Rewrite
# the shipped manifest to point at the built dist so runtime resolution succeeds.
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('$PROJECT_ROOT/packages/shared/package.json','utf8'));p.main='./dist/index.js';p.types='./dist/index.d.ts';fs.writeFileSync('$DEST/platform/packages/shared/package.json',JSON.stringify(p,null,2)+'\n');"

# Templates
mkdir -p "$DEST/platform/templates"
cp "$PROJECT_ROOT/templates/"*.md "$DEST/platform/templates/"

# Watchdog (SIBLING copy, install.sh uses this on a fresh install)
mkdir -p "$DEST/watchdog"
cp -r "$PROJECT_ROOT/watchdog/dist" "$DEST/watchdog/" 2>/dev/null || true
cp "$PROJECT_ROOT/watchdog/package.json" "$DEST/watchdog/"

# Watchdog (BUNDLED INSIDE platform/, closes the in-app-update delivery gap).
# The in-app updater only rewrites ~/.dojo/platform, so the watchdog living at
# ~/.dojo/watchdog was never refreshed by an update. Shipping the built watchdog
# inside platform/ lets the platform self-install it (services/watchdog-refresh.ts,
# before migrations on the next boot) so the new watchdog rides along inside the one
# directory the updater actually installs. node_modules is intentionally omitted
# (mirrors the sibling copy above + install.sh, which runs `npm ci` in
# ~/.dojo/watchdog); the refresh preserves the already-compiled node_modules there.
mkdir -p "$DEST/platform/watchdog-dist"
cp -r "$PROJECT_ROOT/watchdog/dist" "$DEST/platform/watchdog-dist/" 2>/dev/null || true
cp "$PROJECT_ROOT/watchdog/package.json" "$DEST/platform/watchdog-dist/"
# Version marker read by the boot-time refresh: "<platformVersion> <distHash>".
# The platform version drives the "is the bundle newer" decision; the content hash
# lets a same-version watchdog rebuild still trigger a refresh. Deterministic
# ordering so the hash is stable across builds of identical output.
PLATFORM_VERSION="$(node -e "console.log(require('$PROJECT_ROOT/package.json').version)")"
WATCHDOG_HASH="$(cd "$DEST/platform/watchdog-dist" && find dist package.json -type f -print0 2>/dev/null | sort -z | xargs -0 cat 2>/dev/null | shasum -a 256 | cut -c1-16)"
printf '%s %s\n' "$PLATFORM_VERSION" "$WATCHDOG_HASH" > "$DEST/platform/watchdog-dist/watchdog.version"

# Build menu bar app
echo "📦 Building menu bar app..."
cd "$PROJECT_ROOT/menubar"
bash build.sh
cd "$PROJECT_ROOT"

# Deploy scripts + app
cp "$SCRIPT_DIR/install.sh" "$DEST/"
cp "$SCRIPT_DIR/uninstall.sh" "$DEST/"
cp -r "$SCRIPT_DIR/scripts" "$DEST/"
cp -r "$SCRIPT_DIR/launchd" "$DEST/"

# Menu bar app + icon. The icon now lives inside the repo (deploy/dojologo.pdf);
# the old external path ($PROJECT_ROOT/..) is only a legacy fallback. Sourcing
# it from outside the repo is what lost the icon when the workspace moved
# machines. The app bundle already embeds the icon (see menubar/build.sh); this
# copy is the ~/.dojo/ runtime fallback used by install.sh.
cp -r "$PROJECT_ROOT/menubar/build/DOJO.app" "$DEST/DOJO.app"
ICON_PDF="$SCRIPT_DIR/dojologo.pdf"
[[ -f "$ICON_PDF" ]] || ICON_PDF="$(cd "$PROJECT_ROOT/.." && pwd)/dojologo.pdf"
if [[ -f "$ICON_PDF" ]]; then
    cp "$ICON_PDF" "$DEST/dojologo.pdf"
fi

# README
cat > "$DEST/README.md" << 'READMEEOF'
# Agent D.O.J.O. — Delegated Operations & Job Orchestration

## Quick Start

1. Unzip this archive
2. Open Terminal
3. Run: `cd dojo-platform && bash install.sh`
4. The setup wizard will open in your browser

## Requirements

- macOS 13+ (Ventura or later)
- 8GB+ RAM (16GB recommended for local models)
- Internet connection (for initial setup)

## After Install

- Dashboard: http://localhost:3000
- Start: `~/.dojo/scripts/start.sh`
- Stop: `~/.dojo/scripts/stop.sh`
- Status: `~/.dojo/scripts/status.sh`
- Uninstall: `~/.dojo/scripts/uninstall.sh`

## Data Location

All data stored in `~/.dojo/`:
- `data/dojo.db` — Database
- `secrets.yaml` — API keys and the credential master key (plaintext, owner-only permissions — back it up as carefully as you would a password file)
- `prompts/` — Customizable agent prompts
- `techniques/` — Learned techniques
- `logs/` — Application logs
READMEEOF

chmod +x "$DEST/install.sh"
chmod +x "$DEST/uninstall.sh"
chmod +x "$DEST/scripts/"*.sh

# Create zip
echo "📦 Creating zip archive..."
cd "$DIST_DIR"
zip -r "$OUTPUT_NAME.zip" "$OUTPUT_NAME/" -x "*/node_modules/*" "*/.*"

# Build .pkg installer
echo "📦 Building .pkg installer..."
cd "$DIST_DIR"

# Create component package (installs to temp location)
pkgbuild \
    --root "$OUTPUT_NAME" \
    --identifier com.dojo.platform \
    --version 1.0 \
    --install-location /tmp/dojo-install \
    --scripts "$SCRIPT_DIR/pkg-scripts" \
    dojo-component.pkg

# Create final product package with welcome/license/conclusion screens
productbuild \
    --distribution "$SCRIPT_DIR/distribution.xml" \
    --resources "$SCRIPT_DIR/pkg-resources" \
    --package-path "$DIST_DIR" \
    "Agent-DOJO-Installer.pkg"

# Clean up intermediate
rm -f dojo-component.pkg

echo ""
echo "════════════════════════════════════════"
echo "✅ Build complete!"
echo "════════════════════════════════════════"
echo ""
echo "  Zip:       $DIST_DIR/$OUTPUT_NAME.zip ($(du -sh "$OUTPUT_NAME.zip" | cut -f1))"
echo "  Installer: $DIST_DIR/Agent-DOJO-Installer.pkg ($(du -sh "Agent-DOJO-Installer.pkg" | cut -f1))"
echo ""
echo "  Zip method:  unzip → cd dojo-platform → bash install.sh"
echo "  Pkg method:  double-click Agent-DOJO-Installer.pkg"
