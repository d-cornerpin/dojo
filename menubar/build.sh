#!/bin/bash
set -e

# ════════════════════════════════════════
# Build DOJO Menu Bar App
# Compiles the Swift source into a macOS .app bundle
# ════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="DOJO"
BUNDLE_ID="com.dojo.menubar"
OUTPUT_DIR="$SCRIPT_DIR/build"
APP_DIR="$OUTPUT_DIR/$APP_NAME.app"

echo "🥋 Building DOJO Menu Bar app..."

rm -rf "$OUTPUT_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Compile Swift
echo "   Compiling..."
swiftc "$SCRIPT_DIR/DojoMenuBar.swift" \
    -o "$APP_DIR/Contents/MacOS/$APP_NAME" \
    -framework Cocoa \
    -parse-as-library \
    -O \
    -target arm64-apple-macos13

# Copy icon
ICON_PDF="$PROJECT_ROOT/../dojologo.pdf"
if [[ -f "$ICON_PDF" ]]; then
    cp "$ICON_PDF" "$APP_DIR/Contents/Resources/dojologo.pdf"
    echo "   Icon included"
fi

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>Agent D.O.J.O.</string>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

echo "✅ Built: $APP_DIR"
echo "   To install: cp -r \"$APP_DIR\" /Applications/"
echo "   To run: open \"$APP_DIR\""
