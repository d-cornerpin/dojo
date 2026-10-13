// ════════════════════════════════════════
// THE TEST NETS THAT MUST REACH EVERY PROCESS (t140 round 2, widened round 5).
//
// Loaded by `vitest.setup.ts` into every test worker, and carried from there into EVERY Node
// process the suite starts (a `node -e`, a `tsx` script, an `npm` run, and theirs in turn)
// through NODE_OPTIONS `--require`. Round 3 recorded that the nets stopped at the worker: a
// process a test started inherited only the scrubbed environment, and nothing stopped it
// starting the real CLI or reaching the network. CommonJS, plain JavaScript, no dependencies:
// it has to load before anything else in a process that may not be a vitest worker at all.
//
// Two nets, each refusing loudly, by name:
//   1. THE CLI NET — no process may START the Claude CLI or the Agent SDK's CLI. It asks what
//      PROGRAM a child_process call starts (the executable's own name, any case — a case-
//      insensitive disk runs `Claude` as `claude`), and what a shell line starts (the program of
//      each command on it). It does not match words: `echo claude` is an ordinary command, and a
//      checkout under a folder like "…/Claude Code Projects/…" is not the CLI.
//      Round 7 (re-review net residue): what a SHELL runs once it is running — `sh -c claude`, a
//      `$(…)`, an escaped name — no parser of the line can see. So the net also resolves the name
//      the way the shell will: a stand-in `claude` that refuses is put FIRST on every process's
//      PATH (and on the PATH of any environment a child is handed), so whatever a shell resolves
//      as `claude` is the stand-in (`test-net-stand-in/claude`, checked in: it exits 97, loudly).
//   2. THE NETWORK NET — no process may open a connection to anything but this machine. Every
//      TCP/TLS connection goes through `net.Socket.prototype.connect` (fetch/undici, http, https,
//      tls), so that one door is netted: a loopback host or a local socket path passes; anything
//      else is refused before a packet leaves. A test that needs a server starts its own locally.
// ════════════════════════════════════════
'use strict';

const childProcess = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const AGENT_CLI_NET_MESSAGE = 'TEST NET: a test tried to start the real Claude CLI / Agent SDK. Script the in-tree transport (providers/anthropic-sdk.js) instead.';
const NETWORK_NET_MESSAGE = 'TEST NET: a test tried to reach the network';

/**
 * Is `host` this machine? Round 6 (final review M3): LITERAL loopback only — a 127.0.0.0/8 address,
 * ::1 or localhost (no host at all means localhost) — so a hostname that merely starts with "127."
 * is a name to resolve elsewhere, and is refused. Pure; exported so the rule itself can be pinned.
 */
const isThisMachine = (host) => host === undefined || host === null || host === '' || host === 'localhost'
  || /^127(\.\d{1,3}){3}$/.test(host) || host === '::1' || host === '[::1]' || /^::ffff:127(\.\d{1,3}){3}$/i.test(host);

/** Round 7: where the stand-in `claude` lives. */
const STAND_IN_DIR = path.join(__dirname, 'test-net-stand-in');
/** PATH with the stand-in first (once). */
const withTheStandIn = (current) => {
  const parts = String(current ?? '').split(path.delimiter).filter((p) => p && p !== STAND_IN_DIR);
  return [STAND_IN_DIR, ...parts].join(path.delimiter);
};

if (!globalThis.__dojoTestNetsLoaded) {
  globalThis.__dojoTestNetsLoaded = true;

  // ── 1. THE CLI NET ──────────────────────────────────────────────────────────────────────────
  const CLI_PROGRAM = /^claude(\.exe|\.cmd)?$/i;
  const CLI_PACKAGE = /claude-agent-sdk|@anthropic-ai[\\/]claude-code/i;
  const SHELLS = /^(sh|bash|zsh|dash|ksh|cmd(\.exe)?|powershell(\.exe)?|pwsh)$/i;

  // Round 6 (final review M2): programs that only START another program. The net looks through
  // them to the program they run, so `env claude`, `nohup claude` and `exec claude` are the CLI.
  const WRAPPERS = /^(env|nohup|exec|command|builtin|time|nice|ionice|stdbuf|nocache|caffeinate|sudo|doas)$/;
  const words = (text) => (String(text).match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));
  /** The program a list of words starts: assignments, wrappers and their options skipped. */
  const programOf = (ws) => {
    let i = 0;
    for (;;) {
      while (i < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]) || /^-/.test(ws[i]) || /^\d+$/.test(ws[i]))) i++;
      if (i < ws.length && WRAPPERS.test(path.basename(ws[i]))) { i++; continue; }
      return ws[i] ?? '';
    }
  };
  /** The program each command on a shell line starts (subshell and group brackets stripped). */
  const programsOn = (line) => String(line).split(/&&|\|\||[;|\n]/)
    .map((segment) => programOf(words(segment.trim().replace(/^[({\s]+/, '').replace(/[)}\s]+$/, ''))))
    .filter(Boolean);
  const isTheCli = (program) => typeof program === 'string' && CLI_PROGRAM.test(path.basename(program));

  /** Would this child_process call start the CLI? */
  const startsTheCli = (fn, args) => {
    const strings = args.flatMap((a) => (Array.isArray(a) ? a : [a])).filter((a) => typeof a === 'string');
    if (CLI_PACKAGE.test(strings.join(' '))) return true;   // node running the SDK's own CLI script
    if (fn === 'exec' || fn === 'execSync') return programsOn(args[0]).some(isTheCli);
    const file = args[0];
    if (isTheCli(file)) return true;
    const argv = Array.isArray(args[1]) ? args[1] : [];
    if (typeof file === 'string' && WRAPPERS.test(path.basename(file)) && isTheCli(programOf(argv.map(String)))) return true;
    const options = args.find((a) => a && typeof a === 'object' && !Array.isArray(a));
    if (typeof file === 'string' && SHELLS.test(path.basename(file))) {
      const i = argv.findIndex((a) => a === '-c' || a === '/c' || a === '-Command');
      if (i >= 0 && typeof argv[i + 1] === 'string') return programsOn(argv[i + 1]).some(isTheCli);
    }
    if (options && options.shell && typeof file === 'string') return programsOn([file, ...argv].join(' ')).some(isTheCli);
    return false;
  };

  /** NODE_OPTIONS that load this file, added to whatever is there. */
  const SELF = __filename;
  const withTheNets = (existing) => {
    const current = typeof existing === 'string' ? existing : '';
    return current.includes(SELF) ? current : `${current} --require ${JSON.stringify(SELF)}`.trim();
  };
  /** A call that hands its child a whole environment of its own still carries the nets. */
  const carryTheNets = (args) => {
    for (const a of args) {
      if (a && typeof a === 'object' && !Array.isArray(a) && a.env && typeof a.env === 'object') {
        a.env = { ...a.env, NODE_OPTIONS: withTheNets(a.env.NODE_OPTIONS), PATH: withTheStandIn(a.env.PATH) };
      }
    }
  };

  // Round 7: the stand-in `claude` (checked in, nothing made or removed at run time), first on PATH.
  process.env.PATH = withTheStandIn(process.env.PATH);

  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const real = childProcess[name];
    childProcess[name] = function netted(...args) {
      if (startsTheCli(name, args)) {
        const line = args.flatMap((a) => (Array.isArray(a) ? a : [a])).filter((a) => typeof a === 'string').join(' ');
        throw new Error(`${AGENT_CLI_NET_MESSAGE} (child_process.${name}: ${line.slice(0, 120)})`);
      }
      carryTheNets(args);
      return real.apply(this, args);
    };
  }
  syncBuiltinESMExports();   // the SDK's own `import { spawn }` sees the netted function too
  process.env.NODE_OPTIONS = withTheNets(process.env.NODE_OPTIONS);

  // ── 2. THE NETWORK NET ──────────────────────────────────────────────────────────────────────
  /** Where a `connect` call is going: `{ path }` for a local socket, else `{ host, port }`. */
  const destination = (args) => {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === 'object') return { path: first.path, host: first.host, port: first.port };
    if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      return { host: typeof args[1] === 'string' ? args[1] : undefined, port: first };
    }
    if (typeof first === 'string') return { path: first };
    return {};
  };
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function nettedConnect(...args) {
    const to = destination(args);
    if (!to.path && !isThisMachine(to.host)) {
      const err = new Error(`${NETWORK_NET_MESSAGE} (${to.host}:${to.port}). Start a local server, or script the call.`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return realConnect.apply(this, args);
  };
}

module.exports = { AGENT_CLI_NET_MESSAGE, NETWORK_NET_MESSAGE, isThisMachine, STAND_IN_DIR };
