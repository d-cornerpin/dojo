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
cp -r "$PROJECT_ROOT/packages/server/src/db/migrations" "$DEST/platform/packages/server/migrations"
cp -r "$PROJECT_ROOT/packages/dashboard/dist" "$DEST/platform/packages/dashboard/"
cp "$PROJECT_ROOT/packages/dashboard/package.json" "$DEST/platform/packages/dashboard/"
cp -r "$PROJECT_ROOT/packages/shared/dist" "$DEST/platform/packages/shared/"
cp "$PROJECT_ROOT/packages/shared/package.json" "$DEST/platform/packages/shared/"

# Templates
mkdir -p "$DEST/platform/templates"
cp "$PROJECT_ROOT/templates/"*.md "$DEST/platform/templates/"

# Watchdog
mkdir -p "$DEST/watchdog"
cp -r "$PROJECT_ROOT/watchdog/dist" "$DEST/watchdog/" 2>/dev/null || true
cp "$PROJECT_ROOT/watchdog/package.json" "$DEST/watchdog/"

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

# Menu bar app + icon
cp -r "$PROJECT_ROOT/menubar/build/DOJO.app" "$DEST/DOJO.app"
ICON_PDF="$(cd "$PROJECT_ROOT/.." && pwd)/dojologo.pdf"
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
- `secrets.yaml` — API keys (encrypted at rest)
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
