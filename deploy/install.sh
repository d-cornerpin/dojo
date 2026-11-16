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

# RAM check. The floor is 16GB (owner, v3.5): the Dojo keeps two small local models of its own
# resident beside macOS and the engine. A smaller Mac is warned and asked, never refused.
RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
if [[ $RAM_GB -lt 16 ]]; then
    echo "⚠️  This Mac has ${RAM_GB}GB of memory. The Dojo needs 16GB: it runs two small local models of its own (about 6GB) beside macOS and the engine, so a smaller Mac will be slow and will have no room for a local agent model."
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

# ── Install system dependencies (whisper-cpp etc.) ──
# The same script is also invoked at server startup, so any deps added
# in future releases get picked up on the next reboot. Running it here
# too means fresh installs don't have to wait for first server boot.

SYSTEM_DEPS_SCRIPT="$SCRIPT_DIR/platform/packages/server/scripts/ensure-system-deps.sh"
if [[ -f "$SYSTEM_DEPS_SCRIPT" ]]; then
    echo ""
    echo "📦 Checking system dependencies..."
    bash "$SYSTEM_DEPS_SCRIPT"
fi

# ── imsg (iMessage CLI) — handled by ensure-system-deps.sh ──
# imsg install/repair (build from source + copy the PhoneNumberKit resource
# bundle alongside the binary) now lives in ensure-system-deps.sh, which we
# already ran above (line ~105) AND which re-runs at every server startup, so a
# broken imsg self-heals on the next reboot/update. Kept out of here to avoid a
# second, divergent copy of the same logic.

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
mkdir -p "$LAUNCH_DIR"

# ── Install platform files ──
# v3.4 (t197): the platform is prepared BESIDE the installed one (files copied, dependencies
# installed, the database module loaded as a check) and switched in by two renames, by the same
# installer the in-app update uses. If this window is closed part-way, Dojo is left wholly on
# the old version or wholly on the new one, never a mix, and nothing is half-installed.

echo "📋 Installing platform files (this may take a minute)..."
if [[ ! -d "$SCRIPT_DIR/platform" ]]; then
    echo "❌ Platform files not found in $SCRIPT_DIR/platform/"
    exit 1
fi
if ! node "$SCRIPT_DIR/platform/packages/server/dist/update/install-tree-cli.js" "$SCRIPT_DIR/platform"; then
    echo "❌ The platform could not be installed (the reason is above). Your existing Dojo, if any, was not changed."
    exit 1
fi

# Copy watchdog
# The new watchdog is STAGED beside the installed one (copy, version stamp, dependencies), and only
# when all of that succeeded is it switched in by two renames. On any failure the installed
# watchdog is untouched and still works; the staging folder is removed.
# What to tell the person when the watchdog step fails. On a FIRST install nothing is loaded, so
# "not started" is true. On a reinstall the earlier services are still loaded and the new platform
# is already switched in, so say what is installed and what is still running.
say_watchdog_stop_state() {
    # Read the list into a variable first (no pipe, so no SIGPIPE false "missing"); exact label.
    local listing; listing="$(launchctl list 2>/dev/null)"
    if grep -Eq '(^|[[:space:]])com\.dojo\.platform$' <<<"$listing"; then
        echo "   The new platform is installed, but the watchdog could not be updated. The old watchdog is still in place and the Dojo that was already running is still running (it has not been restarted)."
    else
        echo "   Dojo was not started."
    fi
}
WD_STAGE="$DOJO_DIR/watchdog.staging-$$"
WD_OLD="$DOJO_DIR/watchdog.old-$$"
rm -rf "$DOJO_DIR"/watchdog.staging-* 2>/dev/null   # left by an installer that was cut off
# An installer killed between the two renames below leaves NO watchdog, only watchdog.old-<pid>.
# Put the newest one back before anything else, so a working watchdog is in place even if this run
# stops later; with a watchdog in place, the old folders are stale and go.
if [[ ! -d "$DOJO_DIR/watchdog" ]]; then
    wd_prev="$(ls -dt "$DOJO_DIR"/watchdog.old-* 2>/dev/null | head -1)"
    [[ -n "$wd_prev" ]] && mv "$wd_prev" "$DOJO_DIR/watchdog"
fi
[[ -d "$DOJO_DIR/watchdog" ]] && rm -rf "$DOJO_DIR"/watchdog.old-* 2>/dev/null
wd_fail() { rm -rf "$WD_STAGE"; }
if [[ -d "$SCRIPT_DIR/watchdog" ]]; then
    rm -rf "$WD_STAGE"
    if ! rsync -a "$SCRIPT_DIR/watchdog/" "$WD_STAGE/"; then
        wd_fail
        echo "❌ The watchdog (the part that repairs Dojo if an update goes wrong) could not be copied into $DOJO_DIR."
        say_watchdog_stop_state
        echo "   Check that the disk is not full, then run the installer again."
        exit 1
    fi
    # Stamp the watchdog version marker (ships inside platform/watchdog-dist) beside the
    # installed watchdog so the platform's boot-time self-refresh sees a fresh install as
    # already up-to-date and does not needlessly re-copy + kickstart on the first boot.
    if [[ -f "$SCRIPT_DIR/platform/watchdog-dist/watchdog.version" ]]; then
        cp "$SCRIPT_DIR/platform/watchdog-dist/watchdog.version" "$WD_STAGE/watchdog.version"
    fi
    # Watchdog deps (the platform's were installed and checked above, before the switch)
    if [[ -f "$WD_STAGE/package.json" ]]; then
        if ! ( cd "$WD_STAGE" && { npm ci --production 2>/dev/null || npm install --production; } ); then
            wd_fail
            echo "❌ The watchdog's supporting files could not be installed (the reason is above)."
            echo "   The watchdog repairs Dojo if an update goes wrong, so the install is stopped."
            say_watchdog_stop_state
            echo "   Check your internet connection and the disk space, then run the installer again."
            exit 1
        fi
    fi
    # Switch in: old aside, new in, old removed. A failed second rename puts the old one back.
    if [[ -d "$DOJO_DIR/watchdog" ]] && ! mv "$DOJO_DIR/watchdog" "$WD_OLD"; then
        wd_fail
        echo "❌ The new watchdog could not be switched in."
        say_watchdog_stop_state
        exit 1
    fi
    if ! mv "$WD_STAGE" "$DOJO_DIR/watchdog"; then
        [[ -d "$WD_OLD" ]] && mv "$WD_OLD" "$DOJO_DIR/watchdog"
        wd_fail
        echo "❌ The new watchdog could not be switched in."
        say_watchdog_stop_state
        exit 1
    fi
    rm -rf "$WD_OLD"
fi

# Copy scripts
mkdir -p "$DOJO_DIR/scripts"
cp "$SCRIPT_DIR/scripts/"*.sh "$SCRIPT_DIR/scripts/"*.md "$DOJO_DIR/scripts/" 2>/dev/null || true
cp "$SCRIPT_DIR/uninstall.sh" "$DOJO_DIR/scripts/" 2>/dev/null || true
chmod +x "$DOJO_DIR/scripts/"*.sh

# ── Generate secrets ──

SECRETS_FILE="$DOJO_DIR/secrets.yaml"
if [[ ! -f "$SECRETS_FILE" ]] || ! grep -q "jwt_secret:" "$SECRETS_FILE" 2>/dev/null; then
    echo ""
    echo "🔐 Generating security keys..."
    JWT_SECRET=$(openssl rand -hex 32)
    cat > "$SECRETS_FILE" << EOF
jwt_secret: ${JWT_SECRET}
providers: {}
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
    # Idempotent (FA-D7): remove any existing bundle FIRST. `cp -r src dest`
    # when dest is an existing directory copies src INSIDE it
    # (/Applications/DOJO.app/DOJO.app), which nests the bundle and breaks both
    # the app and the rollback UI. rm -rf guarantees a clean top-level install
    # on a re-run or upgrade.
    rm -rf /Applications/DOJO.app
    cp -r "$SCRIPT_DIR/DOJO.app" /Applications/DOJO.app
    # Add to login items so it starts on boot. Delete any existing "DOJO" entry
    # FIRST so a re-run doesn't stack duplicate login items.
    osascript -e 'tell application "System Events" to delete (every login item whose name is "DOJO")' 2>/dev/null || true
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

# Idempotent (FA-D7): a `launchctl load` of an already-loaded label is a no-op,
# so on a re-run/upgrade the freshly-written plists above would NOT take effect
# until a reboot. Unload any existing jobs first so the new plists apply now.
# Unloading a not-loaded job is harmless (hence 2>/dev/null || true).
launchctl unload "$LAUNCH_DIR/com.dojo.platform.plist" 2>/dev/null || true
launchctl unload "$LAUNCH_DIR/com.dojo.watchdog.plist" 2>/dev/null || true
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

# Any answer means it is listening: the page it serves while starting reloads itself until the wizard is ready.
if ! curl -s "http://localhost:${API_PORT}/api/health" >/dev/null 2>&1; then
    echo ""
    echo "❌ The DOJO server did not start. Check logs at: ~/.dojo/logs/"
    echo "   Try: cat ~/.dojo/logs/platform.stderr.log"
    exit 1
fi
echo ""
echo "🌐 Opening setup wizard..."
open "http://localhost:${DASHBOARD_PORT}"
if [[ -d "/Applications/DOJO.app" ]]; then
    open /Applications/DOJO.app
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
echo "    Restore data: ~/.dojo/scripts/restore-db.sh"
echo "    If an update fails: ~/.dojo/scripts/IF-AN-UPDATE-FAILS.md"
echo "    Uninstall: ~/.dojo/scripts/uninstall.sh"
echo ""
echo "  The setup wizard should have opened in"
echo "  your browser. If not, visit the URL above."
echo ""
