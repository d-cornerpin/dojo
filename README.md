<p align="center">
  <img src="packages/dashboard/public/dojologo.svg" alt="Agent D.O.J.O." width="120" />
</p>

<h1 align="center">Agent D.O.J.O.</h1>
<p align="center"><strong>Delegated Operations & Job Orchestration</strong></p>

<p align="center">
  Your AI agents don't train themselves.<br/>
  This is where they learn to fight.
</p>

<p align="center">
  <a href="https://github.com/d-cornerpin/dojo/releases/latest"><strong>Download the Installer</strong></a> ·
  <a href="#quick-start">Enter the Dojo</a>
</p>

---

## Strike First. Strike Hard. No Mercy.

Look — most people run ONE AI agent and think they're hot stuff. That's like showing up to the All Valley with a yellow belt.

Agent D.O.J.O. is a full combat-ready AI dojo running on YOUR Mac. You've got a Sensei calling the shots, a squad of fighters executing missions, and a war room dashboard where you watch it all go down in real time.

You give the order. Your agents handle the rest. They plan. They fight. They don't quit until the job is done.

**This isn't some cloud-hosted, hand-holding, ask-me-nicely AI toy.** This is self-hosted. Everything runs on your machine. Your data stays on your machine. No one's watching. No one's throttling you. You're in control.

## What's in the Dojo

**The Sensei (Primary Agent)**
Your main fighter. Takes your commands, breaks them down, recruits a squad, delegates the work, and reports back when the mission is complete. Think of it as your AI operations commander.

**The Planner (PM Agent)**
Every dojo needs discipline. The Planner watches the tracker board, pokes agents that slack off, and escalates problems before they become disasters. It never sleeps.

**The Trainer (Technique Agent)**
Your agents can learn new moves and save them as reusable techniques. The Trainer helps you build these — step by step — so any agent in the dojo can pick them up and execute. Train once, fight forever.

**Squads**
Need a research team? Form a squad. Need five agents hitting different APIs at once? Form a squad. Agents work in parallel, share context, and clean up when they're done. No dead weight.

## The Belt System

| Rank | What It Means |
|------|--------------|
| **Sensei** 🟡 | Permanent. The masters. Can't be dismissed. They run the dojo. |
| **Ronin** 🔵 | Persistent warriors. Survive restarts. Only you can dismiss them. |
| **Apprentice** ⚪ | Temporary fighters. They come in, do the job, and get dismissed. |

## The Arsenal

**Multi-Provider AI** — Anthropic, OpenAI, OpenRouter, Ollama. Use cloud models, local models, or both. The smart router picks the best fighter for each round automatically.

**Technique System** — Your agents learn moves and save them. Research techniques. Deployment techniques. Monitoring techniques. Build them with the Trainer, publish them, equip them on any agent.

**Project Tracker** — Kanban board. Scheduled tasks. Recurring missions. Dependency chains. The PM watches everything and hits agents with a poke if they stall.

**iMessage Bridge** — Step away from the dojo and your agents reach you through iMessage. Toggle between "In the Dojo" and "Away" — when you're away, they text you the important stuff. No spam. Just the hits that matter.

**Remote Access** — Cloudflare Tunnel built in. Access your dojo from anywhere. One toggle. No config.

**Watchdog** — An independent process that monitors the whole platform. If the dojo goes down, it restarts it. If something's wrong, it texts you. It doesn't answer to the main server. It answers to no one.

**Menu Bar App** — 🥋 right there in your menu bar. Click it to enter the dojo, check status, start or stop the server. No need to remember URLs.

## Quick Start

### The Easy Way (Recommended)

1. Download **[Agent-DOJO-Installer.pkg](https://github.com/d-cornerpin/dojo/releases/latest)**
2. Double-click it
3. The setup wizard opens — follow the steps
4. 🥋 appears in your menu bar. You're in.

### The Hard Way (From Source)

```bash
git clone https://github.com/d-cornerpin/dojo.git
cd dojo
npm install
npm run dev
```

Open `http://localhost:3000`. Bow to the mat.

## Requirements

- macOS 13+ (Ventura or later)
- 8GB RAM minimum. 16GB if you want to run local models. More is better. Always more.
- Node.js 22+
- Internet for cloud AI providers. Or go fully local with Ollama. Your call.

## Architecture

```
┌─────────────────────────────────────────────┐
│              The War Room                    │
│         (React + Tailwind + Vite)            │
├─────────────────────────────────────────────┤
│              The Engine                      │
│           (Hono + Node.js)                   │
│  ┌─────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ Agent   │ │ Mission  │ │  Technique   │  │
│  │ Runtime │ │ Tracker  │ │    Vault     │  │
│  └─────────┘ └──────────┘ └──────────────┘  │
│  ┌─────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ Memory  │ │  Model   │ │   iMessage   │  │
│  │  Engine │ │  Router  │ │    Bridge    │  │
│  └─────────┘ └──────────┘ └──────────────┘  │
├─────────────────────────────────────────────┤
│            SQLite (WAL mode)                 │
├─────────────────────────────────────────────┤
│    Watchdog    │    Menu Bar    │   Tunnel   │
└─────────────────────────────────────────────┘
```

## Commands

```bash
~/.dojo/scripts/start.sh      # Open the dojo
~/.dojo/scripts/stop.sh       # Close the dojo
~/.dojo/scripts/status.sh     # Check who's fighting
~/.dojo/scripts/backup.sh     # Protect your work
~/.dojo/scripts/uninstall.sh  # Sweep the leg (uninstall)
```

## Data & Privacy

- Everything stored locally in `~/.dojo/`
- API keys encrypted at rest
- No telemetry. No cloud sync. No analytics.
- **Your dojo. Your rules.**

## Tech Stack

- **Backend:** Hono (Node.js), SQLite (better-sqlite3), WebSocket
- **Frontend:** React 18, Tailwind CSS, Vite
- **AI:** Anthropic, OpenAI, OpenRouter, Ollama
- **Native:** Swift (menu bar), launchd (services), AppleScript (iMessage)
- **Deploy:** pkgbuild/productbuild (.pkg installer)

## License

Copyright © 2026 Agent D.O.J.O. Contributors. All rights reserved.

---

<p align="center">
  <em>🥋 Fear does not exist in this dojo.</em>
</p>
