#!/bin/bash

echo ""
echo "🥋 Agent D.O.J.O. Status"
echo "════════════════════════════════════════"
echo ""

# Platform service
PLATFORM_PID=$(launchctl list 2>/dev/null | grep com.dojo.platform | awk '{print $1}')
if [[ -n "$PLATFORM_PID" && "$PLATFORM_PID" != "-" ]]; then
    echo "  Platform:  ✅ Running (PID: $PLATFORM_PID)"
else
    echo "  Platform:  ❌ Not running"
fi

# Watchdog service
WATCHDOG_PID=$(launchctl list 2>/dev/null | grep com.dojo.watchdog | awk '{print $1}')
if [[ -n "$WATCHDOG_PID" && "$WATCHDOG_PID" != "-" ]]; then
    echo "  Watchdog:  ✅ Running (PID: $WATCHDOG_PID)"
else
    echo "  Watchdog:  ❌ Not running"
fi

# Health check
HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null)
if [[ -n "$HEALTH" ]]; then
    AGENTS=$(echo "$HEALTH" | grep -o '"agents":[0-9]*' | cut -d: -f2)
    UPTIME=$(echo "$HEALTH" | grep -o '"uptime":[0-9]*' | cut -d: -f2)
    echo "  API:       ✅ Healthy (${AGENTS} agents, uptime: ${UPTIME}s)"
else
    echo "  API:       ❌ Not responding"
fi

# Database
DB_PATH="$HOME/.dojo/data/dojo.db"
if [[ -f "$DB_PATH" ]]; then
    DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
    echo "  Database:  ✅ ${DB_SIZE}"
else
    echo "  Database:  ❌ Not found"
fi

# Ollama
if command -v ollama &>/dev/null; then
    OLLAMA_MODELS=$(ollama list 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
    echo "  Ollama:    ✅ ${OLLAMA_MODELS} model(s)"
else
    echo "  Ollama:    ⚪ Not installed"
fi

echo ""
echo "  Dashboard: http://localhost:3001"
echo "  Logs:      ~/.dojo/logs/"
echo ""
