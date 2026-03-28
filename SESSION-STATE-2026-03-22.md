# Session State — March 22, 2026

## What This Is
Agent D.O.J.O. (Delegated Operations & Job Orchestration) — a self-hosted AI agent orchestration platform for macOS. The project directory is still named `cornerpin-platform` but the product name is "Agent D.O.J.O." or just "DOJO".

## Project Location
- **Source code**: `/Users/dcliff9/Documents/Claude Code Projects/KEVIN/cornerpin-platform/`
- **GitHub repo**: `https://github.com/d-cornerpin/dojo` (public)
- **Current release**: v1.0.0
- **Installer output**: `/Users/dcliff9/Documents/Claude Code Projects/INSTALLER/`
- **Backups**: `/Users/dcliff9/Documents/Claude Code Projects/BACKUPS/`
- **User data (dev machine)**: `~/.dojo/`
- **User data (Mac Mini deploy target)**: `~/.dojo/` on the Mac Mini

## Key Commands

### Development
```bash
cd /Users/dcliff9/Documents/Claude\ Code\ Projects/KEVIN/cornerpin-platform
npm run dev                    # Start dev server (Vite on 3000, API on 3001)
npm run build                  # Build shared → server → dashboard
npx tsc --noEmit --project packages/server/tsconfig.json    # Type-check server
npx tsc --noEmit --project packages/dashboard/tsconfig.json  # Type-check dashboard
```

### Build & Deploy
```bash
# Build the installer package
bash deploy/build-package.sh
# Output: deploy/dist/Agent-DOJO-Installer.pkg and deploy/dist/dojo-platform.zip

# Copy to INSTALLER folder
cp deploy/dist/Agent-DOJO-Installer.pkg /Users/dcliff9/Documents/Claude\ Code\ Projects/INSTALLER/

# In production, everything runs on port 3001 (not 3000)
```

### Git & GitHub
```bash
# Git user: David <david@cornerp.in>
# GitHub: d-cornerpin/dojo
# Auth: gh CLI (already authenticated)

git add -A && git commit -m "message" && git push origin main

# Update the release installer:
gh release upload v1.0.0 /Users/dcliff9/Documents/Claude\ Code\ Projects/INSTALLER/Agent-DOJO-Installer.pkg --clobber
```

### Watchdog (separate build)
```bash
cd watchdog && npx tsc    # Compile watchdog TypeScript
```

### Menu Bar App (Swift)
```bash
cd menubar && bash build.sh   # Compiles DojoMenuBar.swift → DOJO.app
```

## Architecture Overview

### Package Structure
- `packages/shared/` — Shared types (@dojo/shared)
- `packages/server/` — Hono API server, agent runtime, tools, memory, tracker
- `packages/dashboard/` — React + Tailwind + Vite frontend
- `watchdog/` — Independent health monitor process
- `menubar/` — Native Swift menu bar app
- `deploy/` — Installer scripts, launchd plists, pkg resources
- `templates/` — SOUL.md, PM-SOUL.md, TRAINER-SOUL.md, USER.md

### Database
- SQLite at `~/.dojo/data/dojo.db`
- Migrations in `packages/server/src/db/migrations/` (013 files, numbered 002-014)
- CRITICAL: For deploy, migrations must be copied to `dist/db/migrations/` (the compiled JS looks there via `__dirname`)

### Three Core Agents (Sensei classification)
1. **Primary Agent** (Dojo Master) — main agent, orchestrates everything
2. **PM Agent** (Dojo Planner) — monitors tracker, pokes stalled agents, escalates to primary
3. **Trainer Agent** (Dojo Trainer) — builds techniques, speaks like a wise martial arts master

### Agent Classifications
- `sensei` — permanent, can't be dismissed
- `ronin` — persistent, only user can dismiss
- `apprentice` — temporary, auto-dismisses after timeout

### Task Statuses
- `on_deck` — waiting (was "pending")
- `in_progress` — being worked on
- `complete` — done
- `blocked` — stuck
- `fallen` — failed (was "failed")

### Config Paths
- `~/.dojo/data/dojo.db` — database
- `~/.dojo/secrets.yaml` — API keys, JWT secret, password hash
- `~/.dojo/prompts/` — customizable agent prompts
- `~/.dojo/techniques/` — learned technique packages
- `~/.dojo/uploads/` — user file uploads
- `~/.dojo/logs/dojo.log` — application log

### Production Notes
- In production (`NODE_ENV=production`), the server serves dashboard static files from `packages/dashboard/dist/`
- Everything runs on port 3001 (no Vite)
- launchd plists need `PATH` set to include `/opt/homebrew/bin` for Homebrew tools
- `secrets.yaml` must have `dashboard_password_hash: ""` (empty string, not null) for fresh installs
- SQL migrations must be at `dist/db/migrations/` relative to the compiled server code

## Recent Fixes Applied (This Session)

### PM Agent Overhaul
- Removed `imessage_send` from PM tools — PM can no longer send iMessages directly
- PM escalates to primary agent via `send_to_agent`, primary decides about owner contact
- Added `broadcast_to_group` to PM tools
- Scheduled task awareness: `[SCHEDULED — waiting]` vs `[OVERDUE]` labels in review
- Review prompt explicitly says not to flag waiting scheduled tasks

### Primary Agent Owner Communication
- New "Contacting the Owner" section in primary agent's prompt
- Clear do/don't lists for when to send iMessages
- Primary is the sole gatekeeper for owner communication

### Scheduler Bug Fix
- `calculateNextRun()` was adding interval to scheduled_start even for brand new tasks
- Fixed: if `!task.last_run_at && task.run_count === 0`, return `scheduled_start` directly
- First run now fires AT the scheduled time, not one interval AFTER

### Agent Collaboration Overhaul
- `send_to_agent` messages include sender name, ID, and reply instructions
- New `broadcast_to_group` tool for messaging all agents in a squad
- Sub-agents get comprehensive onboarding prompt: identity, parent, PM, squad members, communication guide
- Sub-agents NO LONGER get the primary agent's SOUL.md

### Mandatory Tracker
- Every agent with tracker tools gets "MANDATORY: Project Tracker" in their prompt
- Must create a project BEFORE spawning agents
- Must track all non-trivial work

### Memory Compaction Improvements
- Model-aware tail sizing: 200k models keep 80 messages (was fixed at 32)
- Raised proactive compaction threshold from 10k to 20k tokens
- Summarizer now preserves resolution state (RESOLVED/DECIDED/CLOSED/DEFERRED)

### Bug Fixes from Kevin's Report
- delete_group now terminates members BEFORE deleting group (was leaving orphans)
- Task schedule end conditions (repeat_end_type/value) now saved and displayed correctly
- iMessage bridge seeds lastSeenRowId on first enable (no more message replay)

### Setup Wizard Fixes
- PM and Trainer agents are required (no toggle to disable)
- All three core agents assigned to Masters group on setup completion
- No duplicate agents created at boot (deferred until setup completes)
- iMessage sends welcome message during setup to start bridge immediately
- Dependencies page: extended PATH for Homebrew on Apple Silicon
- Migrations copied to correct dist path for production

### Other Fixes
- Watchdog alert deduplication (2hr cooldown, recovery messages)
- RAM/CPU reporting uses vm_stat and 5-min load average
- iMessage response flags expire after 60 seconds
- Thinking dots clear on agent:status idle event
- Vite `allowedHosts: true` for Cloudflare Tunnel support
- Trainer agent doesn't narrate actions in third person

## What Was Being Tested on Mac Mini
David has a Mac Mini M1 16GB that he deploys to for testing. The flow:
1. Uninstall old version: `~/.dojo/scripts/uninstall.sh`
2. Copy new `.pkg` to Mac Mini
3. Double-click to install
4. Setup wizard runs in browser
5. Test features, find bugs, report back

## User Preferences (from memory)
- David's dev machine: MacBook Pro M3 Max 128GB
- Deploy target: Mac Mini M1 16GB
- Dashboard password during dev: abc123
- Never start/stop the dev server (user owns it)
- Remind user to restart npm run dev after server-side changes
- David's primary agent is named "Kevin"
- David's PM agent is named "Stella"
- David's trainer agent is named "Hamato Yoshi"
- The dojologo.svg and dojologo_favicon.png are in the project root's parent directory (`/Users/dcliff9/Documents/Claude Code Projects/KEVIN/`)
