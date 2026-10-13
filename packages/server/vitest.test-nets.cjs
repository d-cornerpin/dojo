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

if (!globalThis.__dojoTestNetsLoaded) {
  globalThis.__dojoTestNetsLoaded = true;

  // ── 1. THE CLI NET ──────────────────────────────────────────────────────────────────────────
  const CLI_PROGRAM = /^claude(\.exe|\.cmd)?$/i;
  const CLI_PACKAGE = /claude-agent-sdk|@anthropic-ai[\\/]claude-code/i;
  const SHELLS = /^(sh|bash|zsh|dash|ksh|cmd(\.exe)?|powershell(\.exe)?|pwsh)$/i;

  /** The program each command on a shell line starts (env assignments and quotes skipped). */
  const programsOn = (line) => String(line).split(/&&|\|\||[;|\n]/).map((segment) => {
    const m = segment.trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:"([^"]*)"|'([^']*)'|(\S+))/);
    return m ? (m[1] ?? m[2] ?? m[3]) : '';
  }).filter(Boolean);
  const isTheCli = (program) => typeof program === 'string' && CLI_PROGRAM.test(path.basename(program));

  /** Would this child_process call start the CLI? */
  const startsTheCli = (fn, args) => {
    const strings = args.flatMap((a) => (Array.isArray(a) ? a : [a])).filter((a) => typeof a === 'string');
    if (CLI_PACKAGE.test(strings.join(' '))) return true;   // node running the SDK's own CLI script
    if (fn === 'exec' || fn === 'execSync') return programsOn(args[0]).some(isTheCli);
    const file = args[0];
    if (isTheCli(file)) return true;
    const argv = Array.isArray(args[1]) ? args[1] : [];
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
        a.env = { ...a.env, NODE_OPTIONS: withTheNets(a.env.NODE_OPTIONS) };
      }
    }
  };

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
  const isThisMachine = (host) => host === undefined || host === null || host === '' || host === 'localhost'
    || /^127\./.test(host) || host === '::1' || host === '[::1]' || host === '0.0.0.0' || host === '::' || /^::ffff:127\./i.test(host);
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

module.exports = { AGENT_CLI_NET_MESSAGE, NETWORK_NET_MESSAGE };
