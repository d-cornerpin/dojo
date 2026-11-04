// A MAC THAT BEHAVES LIKE ONE, for the tests of the Dojo's Ollama upkeep (field failure 2). Nothing real runs.
//
// The fake that hid field failure 2 had `brew upgrade` bump the RUNNING version. On a real Mac `brew` replaces the program
// ON DISK only, and the process that serves keeps the program it started with until it is stopped and another is started.
// Here, likewise:
//   · `brew upgrade|install ollama` and `brew upgrade|install --cask …` change what is on disk, nothing else;
//   · the version Ollama answers (`/api/version`, over real HTTP) changes only when a serve STARTS (the app opened,
//     Homebrew's service restarted, a supervisor's respawn), from the program on disk at that moment;
//   · nothing serving means nothing answers at all (the connection is refused);
//   · a TERM stops a serve only when it is this user's: another user's or the system's (`foreign`) refuses the signal and
//     `alive` stays true, as `kill` reports EPERM;
//   · a supervisor (`respawn`) starts its program again once its serve is stopped, at once or after `delayMs`, and only
//     while the port is free (a respawn that finds it taken dies, as on a Mac);
//   · Homebrew's service cannot listen while another serve holds the port, and can fail to start at all (`serviceWorks`);
//   · time passes only through `sleep` (the Dojo's own poll), and a serve answers only `startMs` after it starts (a slow
//     cold start; `Infinity`: alive and never answering, as an app behind a first-launch prompt nobody sees);
//   · a listener need not be Ollama at all (Docker Desktop forwarding a container, an `ssh -L` tunnel).
import http from 'node:http';
import type { OllamaHost } from '../ollama-host.js';
import { localHeld } from '../ollama-quiet.js';
import { ollamaAtLeast } from '../ollama-version.js';
import { STANDARD_DECISION_MODEL } from '../local-standard.js';

export const LATEST = '0.41.0';
export const APP_PROGRAM = '/Applications/Ollama.app/Contents/Resources/ollama';
export const cellar = (v: string): string => `/opt/homebrew/Cellar/ollama/${v}/bin/ollama`;
export const REFUSAL = '{"error":"pull model manifest: 412: The model you are attempting to pull requires a newer version of Ollama. Please download the latest version at https://ollama.com/download"}';
const APP_PID = 499;

/** What the fake Ollama answers over HTTP. `serving` is what runs now (null: nothing listens). */
export const ollama = {
  serving: null as { version: string } | null,
  /** Does what serves answer yet (a serve still starting refuses the connection)? Set by the fake Mac. */
  answering: (): boolean => true,
  /** Every pull fails (no network to the registry): a model that stays missing. */
  failPulls: false,
  /** Versions whose `/api/version` says nothing (a very old Ollama). */
  silent: new Set<string>(),
  installed: new Set<string>(),
  pulls: [] as string[],
  /** Refuse every model, not only the decision model, below 0.35 (the registry did, for one case in the field). */
  refuseAllBelow035: false,
};

let server: http.Server | null = null;
export async function startFakeOllama(): Promise<string> {
  server = http.createServer((req, res) => {
    const serving = ollama.serving;
    if (!serving || !ollama.answering()) { req.socket.destroy(); return; }   // nothing listens (yet): the connection is refused
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/version') {
      if (ollama.silent.has(serving.version)) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: serving.version }));
    } else if (url.pathname === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [...ollama.installed].map((name) => ({ name, size: 1 })) }));
    } else if (url.pathname === '/api/pull') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const model = (JSON.parse(body) as { model: string }).model;
        ollama.pulls.push(model);
        if (ollama.failPulls) { res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"registry unreachable"}'); return; }
        const old = !ollamaAtLeast(serving.version, '0.35') && serving.version !== '0.0.0';
        if (old && (ollama.refuseAllBelow035 || model === STANDARD_DECISION_MODEL.tag)) { res.writeHead(412, { 'content-type': 'application/json' }).end(REFUSAL); return; }
        ollama.installed.add(model);
        res.writeHead(200).end(`${JSON.stringify({ status: 'pulling', digest: 'sha256:a', total: 100, completed: 50 })}\n${JSON.stringify({ status: 'success' })}\n`);
      });
    } else res.writeHead(404).end('no route');
  });
  return new Promise((r) => server!.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server!.address() as { port: number }).port}`)));
}
export function stopFakeOllama(): Promise<void> { return new Promise((r) => (server ? server.close(() => r()) : r())); }

/** A process listening on Ollama's port: who supervises it, and whether this user may signal it. */
export interface Serve { pid: number; path: string; version: string; by: 'app' | 'brew-service' | 'unsupervised'; foreign?: boolean; readyAt?: number }

export type Mac = OllamaHost & {
  running: Serve | null;
  disk: { formula: string | null; app: string | null; appCask: string | null };
  /** What `brew` would install now (a box where Homebrew has nothing newer: the version already on disk). */
  latest: string;
  env: Record<string, string>;
  brews: string[][]; setenvs: string[]; terms: number[]; launches: number; serviceRestarts: number;
  heldDuringBrew: boolean[]; downAtBrew: boolean[];
  hasBrewInstalled: boolean; failBrew: boolean; failBrewOnce: boolean; cliOk: boolean; serviceWorks: boolean; serveWorks: boolean; failCask: boolean;
  relaunchGate: Promise<void>;
  /** A supervisor that starts this program again whenever its serve stops (a launchd job of the owner's). `program` null:
   *  the formula's link, so the program on disk then. */
  respawn: { program: string | null; version?: string; delayMs?: number } | null;
  /** A plain `ollama` binary on the PATH that neither Homebrew nor the app owns (the CLI tarball). */
  cli: { path: string; version: string } | null;
  /** How long a serve takes to answer once started (ms of the Dojo's own polling); the app's own may differ. */
  startMs: number; appStartMs: number;
  macos: number | null;
  /** The env of each detached `ollama serve` the Dojo started; the order of `setenv`, `term`, `serve`, `service`, `launch` calls. */
  serves: Array<Record<string, string>>; log: string[];
  now: number;
  /** Let time pass (the Dojo is not polling, the owner is). */
  wait(ms: number): void;
};

let nextPid = 800;
export function fakeMac(o: { running?: Serve | null; formula?: string | null; app?: string | null; appCask?: string | null } = {}): Mac {
  let serve: Serve | null = null;
  let respawnAt: number | null = null;
  const started = new Set<number>();   // pids of serves the Dojo started that are still alive (listening or not)
  const startServeAt = (s: Omit<Serve, 'readyAt'>, startMs: number): void => { m.running = { ...s, readyAt: m.now + startMs }; };
  const respawnNow = (): void => {
    respawnAt = null;
    if (serve || !m.respawn) return;   // the port is taken: the supervisor's respawn dies
    const v = m.respawn.version ?? m.disk.formula ?? 'none';
    startServeAt({ pid: nextPid++, path: m.respawn.program ?? cellar(v), version: v, by: 'unsupervised' }, 0);
  };
  const stop = (): void => {
    m.running = null;
    if (!m.respawn) return;
    if (!m.respawn.delayMs) respawnNow(); else respawnAt = m.now + m.respawn.delayMs;
  };
  const tick = (ms: number): void => { m.now += ms; if (respawnAt !== null && m.now >= respawnAt) respawnNow(); };
  const m: Mac = {
    get running() { return serve; },
    set running(v: Serve | null) { serve = v; ollama.serving = v ? { version: v.version } : null; },
    disk: { formula: o.formula ?? null, app: o.app ?? null, appCask: o.appCask === undefined ? (o.app ? 'ollama-app' : null) : o.appCask },
    latest: LATEST, env: {},
    brews: [], setenvs: [], terms: [], launches: 0, serviceRestarts: 0, heldDuringBrew: [], downAtBrew: [], serves: [], log: [],
    hasBrewInstalled: true, failBrew: false, failBrewOnce: false, cliOk: true, serviceWorks: true, serveWorks: true, failCask: false, relaunchGate: Promise.resolve(), respawn: null,
    cli: null, startMs: 0, appStartMs: 0, macos: 15, now: 0,
    wait: (ms) => tick(ms),
    getenv: async (k) => m.env[k] ?? null,
    setenv: async (k, v) => { m.env[k] = v; m.setenvs.push(`${k}=${v}`); m.log.push('setenv'); },
    listener: async () => (serve ? { pid: serve.pid, path: serve.path } : null),
    appPids: async () => (serve?.by === 'app' ? [APP_PID] : []),
    appInstalled: async () => m.disk.app !== null,
    terminate: (pid) => {
      m.terms.push(pid); m.log.push('term'); started.delete(pid);
      if (serve && !serve.foreign && (pid === serve.pid || (serve.by === 'app' && pid === APP_PID))) stop();
    },
    alive: (pid) => (!!serve && (pid === serve.pid || (serve.by === 'app' && pid === APP_PID))) || started.has(pid),
    launchApp: async () => {
      await m.relaunchGate; m.launches++; m.log.push('launch');
      if (m.disk.app && !serve) startServeAt({ pid: nextPid++, path: APP_PROGRAM, version: m.disk.app, by: 'app' }, m.appStartMs);
    },
    answers: async () => !!serve && m.now >= (serve.readyAt ?? 0),
    sleep: async (ms) => tick(ms),
    brewServicePid: async () => (serve?.by === 'brew-service' ? serve.pid : null),
    hasBrew: async () => m.hasBrewInstalled,
    brewCaskToken: async () => m.disk.appCask,
    brewFormulaInstalled: async () => m.disk.formula !== null,
    macosMajor: async () => m.macos,
    cliRuns: async () => m.cliOk && (m.disk.formula !== null || m.disk.app !== null || m.cli !== null),
    brew: async (args) => {
      m.brews.push(args); m.heldDuringBrew.push(localHeld()); m.downAtBrew.push(!serve);
      if (m.failBrewOnce) { m.failBrewOnce = false; throw new Error('brew hiccup (raw)'); }
      if (m.failBrew) throw new Error('Error: brew exploded (raw)');
      if (args[0] === 'fetch') return;   // the download only: nothing on disk changes
      // The program ON DISK only: whatever serves keeps running the program it started with.
      if (args.includes('--cask')) {
        if (m.failCask || (m.macos ?? 15) < 14) throw new Error('Error: This cask does not run on macOS versions older than Sonoma (raw)');
        m.disk.app = m.latest; m.disk.appCask = args[args.length - 1];
      } else m.disk.formula = m.latest;
    },
    restartBrewService: async () => {
      m.serviceRestarts++; m.log.push('service');
      if (!m.disk.formula) throw new Error('Error: No available formula with the name "ollama" (raw)');
      if (serve?.by === 'brew-service') m.running = null;
      if (!m.serviceWorks) throw new Error('Bootstrap failed: 5: Input/output error (raw)');
      if (serve) return;   // another serve holds the port: launchd's job cannot listen
      startServeAt({ pid: nextPid++, path: cellar(m.disk.formula), version: m.disk.formula, by: 'brew-service' }, m.startMs);
    },
    startServe: (env) => {
      m.serves.push(env); m.log.push('serve');
      const program = m.disk.formula ? { path: cellar(m.disk.formula), version: m.disk.formula } : m.cli ?? (m.disk.app ? { path: APP_PROGRAM, version: m.disk.app } : null);
      if (!program || !m.serveWorks) return null;
      const pid = nextPid++;
      if (!serve) { started.add(pid); startServeAt({ pid, ...program, by: 'unsupervised' }, m.startMs); }   // the port taken: it exits at once
      return pid;
    },
  };
  m.running = o.running ?? null;
  ollama.answering = () => !!serve && m.now >= (serve.readyAt ?? 0);
  return m;
}

/** A serve nothing supervises, from the formula's program at `version` (the 3.4.1 Dojo's `exec('ollama serve')`, a shell's). */
export const formulaServe = (version: string, extra: Partial<Serve> = {}): Serve => ({ pid: 500, path: cellar(version), version, by: 'unsupervised', ...extra });
export const appServe = (version: string): Serve => ({ pid: 500, path: APP_PROGRAM, version, by: 'app' });
export const serviceServe = (version: string): Serve => ({ pid: 500, path: cellar(version), version, by: 'brew-service' });
/** A listener that is not Ollama, forwarding one (Docker Desktop's backend for `docker run -p 11434:11434 ollama/ollama`). */
export const dockerServe = (version: string): Serve => ({ pid: 600, path: '/Applications/Docker.app/Contents/MacOS/com.docker.backend', version, by: 'unsupervised' });
