#!/bin/bash
# Note: intentionally NOT using set -e here. Homebrew and other installers
# can return non-zero during normal operation, which would kill the script.
# We handle errors explicitly where they matter.

# ════════════════════════════════════════
# Agent D.O.J.O. — Installer
# One script to set up everything
# ════════════════════════════════════════

DOJO_DIR="$HOME/.dojo"
PLATFORM_DIR="$DOJO_DIR/platform"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# In production, everything runs on one port
DOJO_PORT=3001
DASHBOARD_PORT=$DOJO_PORT
API_PORT=$DOJO_PORT

echo ""
echo "🥋 Agent D.O.J.O. Installer"
echo "   Delegated Operations & Job Orchestration"
echo ""

# ── Preflight checks ──

echo "Checking system requirements..."

# macOS check
if [[ "$(uname)" != "Darwin" ]]; then
    echo "❌ This installer is for macOS only."
    exit 1
fi

# RAM check
RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
if [[ $RAM_GB -lt 8 ]]; then
    echo "⚠️  Warning: Only ${RAM_GB}GB RAM detected. 8GB+ recommended."
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
fi
echo "✅ macOS $(sw_vers -productVersion) — ${RAM_GB}GB RAM"

# ── Install Homebrew ──

if ! command -v brew &>/dev/null; then
    echo ""
    echo "📦 Installing Homebrew..."
    echo ""
    echo "   ⚠️  Homebrew may ask for your macOS password."
    echo "   This is normal — type your password and press Enter."
    echo "   (You won't see the characters as you type)"
    echo ""
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add to path for this session
    if [[ -f "/opt/homebrew/bin/brew" ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -f "/usr/local/bin/brew" ]]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
    # Verify it actually installed
    if ! command -v brew &>/dev/null; then
        echo ""
        echo "❌ Homebrew installation failed."
        echo "   Install it manually: https://brew.sh"
        echo "   Then re-run this installer."
        exit 1
    fi
else
    echo "✅ Homebrew installed"
fi

# ── Install Node.js 22 ──

NODE_VERSION=""
if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
fi

if [[ -z "$NODE_VERSION" ]] || [[ "$NODE_VERSION" -lt 22 ]]; then
    echo ""
    echo "📦 Installing Node.js 22..."
    brew install node@22
    # Link if not already linked
    brew link --overwrite node@22 2>/dev/null || true
    if ! command -v node &>/dev/null; then
        echo "❌ Node.js installation failed. Cannot continue."
        exit 1
    fi
    echo "✅ Node.js $(node -v) installed"
else
    echo "✅ Node.js v${NODE_VERSION} installed"
fi

# ── Install imsg (iMessage CLI for text + image attachments) ──

if command -v imsg &>/dev/null; then
    echo "✅ imsg CLI installed"
else
    echo ""
    echo "📦 Installing imsg (iMessage CLI)..."
    IMSG_BUILD_DIR=$(mktemp -d)
    if git clone --depth 1 https://github.com/steipete/imsg.git "$IMSG_BUILD_DIR" 2>/dev/null; then
        if (cd "$IMSG_BUILD_DIR" && make build 2>/dev/null); then
            cp "$IMSG_BUILD_DIR/bin/imsg" /usr/local/bin/imsg 2>/dev/null || \
                cp "$IMSG_BUILD_DIR/bin/imsg" /opt/homebrew/bin/imsg 2>/dev/null || \
                (mkdir -p "$HOME/.dojo/bin" && cp "$IMSG_BUILD_DIR/bin/imsg" "$HOME/.dojo/bin/imsg")
            echo "✅ imsg installed"
        else
            echo "⚠️  imsg build failed (optional — iMessage image attachments won't work)"
            echo "   Try manually: git clone https://github.com/steipete/imsg.git && cd imsg && make build && sudo cp bin/imsg /usr/local/bin/"
        fi
    else
        echo "⚠️  Could not clone imsg repo (optional — iMessage image attachments won't work)"
    fi
    rm -rf "$IMSG_BUILD_DIR" 2>/dev/null
fi

# ── Install Google Workspace CLI (optional) ──

if command -v gws &>/dev/null; then
    echo "✅ Google Workspace CLI installed"
else
    echo ""
    echo "📦 Installing Google Workspace CLI..."
    # Try global install first; if EACCES, use ~/.npm-global prefix
    if ! npm install -g @googleworkspace/cli 2>/dev/null; then
        mkdir -p "$HOME/.npm-global"
        npm config set prefix "$HOME/.npm-global"
        export PATH="$HOME/.npm-global/bin:$PATH"
        npm install -g @googleworkspace/cli 2>/dev/null || echo "⚠️  gws CLI install failed (optional — can be set up later)"
    fi
fi

# ── Create directory structure ──

echo ""
echo "📁 Setting up DOJO directories..."

mkdir -p "$DOJO_DIR"/{data,logs,prompts,uploads,techniques}
mkdir -p "$PLATFORM_DIR"
mkdir -p "$LAUNCH_DIR"

# ── Copy platform files ──

echo "📋 Installing platform files..."

# Copy platform
if [[ -d "$SCRIPT_DIR/platform" ]]; then
    rsync -a --delete "$SCRIPT_DIR/platform/" "$PLATFORM_DIR/"
else
    echo "❌ Platform files not found in $SCRIPT_DIR/platform/"
    exit 1
fi

# Copy watchdog
if [[ -d "$SCRIPT_DIR/watchdog" ]]; then
    rsync -a "$SCRIPT_DIR/watchdog/" "$DOJO_DIR/watchdog/"
fi

# Copy scripts
mkdir -p "$DOJO_DIR/scripts"
cp "$SCRIPT_DIR/scripts/"*.sh "$DOJO_DIR/scripts/" 2>/dev/null || true
cp "$SCRIPT_DIR/uninstall.sh" "$DOJO_DIR/scripts/" 2>/dev/null || true
chmod +x "$DOJO_DIR/scripts/"*.sh

# ── Install npm dependencies ──

echo ""
echo "📦 Installing dependencies (this may take a minute)..."
cd "$PLATFORM_DIR"
npm ci --production 2>/dev/null || npm install --production
if [[ ! -d "$PLATFORM_DIR/node_modules" ]]; then
    echo "❌ npm dependency installation failed. Cannot continue."
    exit 1
fi

# Watchdog deps
if [[ -f "$DOJO_DIR/watchdog/package.json" ]]; then
    cd "$DOJO_DIR/watchdog"
    npm ci --production 2>/dev/null || npm install --production
fi

# ── Generate secrets ──

SECRETS_FILE="$DOJO_DIR/secrets.yaml"
if [[ ! -f "$SECRETS_FILE" ]] || ! grep -q "jwt_secret:" "$SECRETS_FILE" 2>/dev/null; then
    echo ""
    echo "🔐 Generating security keys..."
    JWT_SECRET=$(openssl rand -hex 32)
    cat > "$SECRETS_FILE" << EOF
jwt_secret: ${JWT_SECRET}
providers: {}
dashboard_password_hash: ""
EOF
    chmod 600 "$SECRETS_FILE"
fi

# ── Copy icon for menu bar app ──

if [[ -f "$SCRIPT_DIR/dojologo.pdf" ]]; then
    cp "$SCRIPT_DIR/dojologo.pdf" "$DOJO_DIR/dojologo.pdf"
fi

# ── Install menu bar app ──

if [[ -d "$SCRIPT_DIR/DOJO.app" ]]; then
    echo ""
    echo "🥋 Installing DOJO menu bar app..."
    cp -r "$SCRIPT_DIR/DOJO.app" /Applications/DOJO.app
    # Add to login items so it starts on boot
    osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/DOJO.app", hidden:false}' 2>/dev/null || true
    echo "✅ Menu bar app installed"
fi

# ── Install launchd services ──

echo ""
echo "⚙️  Installing system services..."

NODE_PATH=$(which node)

# Platform plist
cat > "$LAUNCH_DIR/com.dojo.platform.plist" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dojo.platform</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PLATFORM_DIR}/packages/server/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PLATFORM_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>DOJO_PORT</key>
        <string>${API_PORT}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${DOJO_DIR}/logs/platform.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${DOJO_DIR}/logs/platform.stderr.log</string>
</dict>
</plist>
PLISTEOF

# Watchdog plist
cat > "$LAUNCH_DIR/com.dojo.watchdog.plist" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dojo.watchdog</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${DOJO_DIR}/watchdog/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${DOJO_DIR}/watchdog</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>DOJO_URL</key>
        <string>http://localhost:${DASHBOARD_PORT}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>${DOJO_DIR}/logs/watchdog.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${DOJO_DIR}/logs/watchdog.stderr.log</string>
</dict>
</plist>
PLISTEOF

# ── Start the platform ──

echo ""
echo "🚀 Starting the DOJO..."

launchctl load "$LAUNCH_DIR/com.dojo.platform.plist"
launchctl load "$LAUNCH_DIR/com.dojo.watchdog.plist"

# Wait for server to be ready
echo -n "   Waiting for server"
for i in $(seq 1 30); do
    if curl -s "http://localhost:${API_PORT}/api/health" >/dev/null 2>&1; then
        echo " ✅"
        break
    fi
    echo -n "."
    sleep 1
done

# Check if it's actually running
if ! curl -s "http://localhost:${API_PORT}/api/health" >/dev/null 2>&1; then
    echo ""
    echo "⚠️  Server hasn't started yet. Check logs at: ~/.dojo/logs/"
    echo "   Try: cat ~/.dojo/logs/platform.stderr.log"
else
    # Open browser
    echo ""
    echo "🌐 Opening setup wizard..."
    open "http://localhost:${DASHBOARD_PORT}"

    # Launch menu bar app
    if [[ -d "/Applications/DOJO.app" ]]; then
        open /Applications/DOJO.app
    fi
fi

echo ""
echo "════════════════════════════════════════"
echo "  🥋 Agent D.O.J.O. installed!"
echo "════════════════════════════════════════"
echo ""
echo "  Dashboard:  http://localhost:${DASHBOARD_PORT}"
echo "  Data:       ~/.dojo/"
echo "  Logs:       ~/.dojo/logs/"
echo ""
echo "  Commands:"
echo "    Start:    ~/.dojo/scripts/start.sh"
echo "    Stop:     ~/.dojo/scripts/stop.sh"
echo "    Status:   ~/.dojo/scripts/status.sh"
echo "    Backup:   ~/.dojo/scripts/backup.sh"
echo "    Uninstall: ~/.dojo/scripts/uninstall.sh"
echo ""
echo "  The setup wizard should have opened in"
echo "  your browser. If not, visit the URL above."
echo ""
