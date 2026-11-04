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
//   · a supervisor (`respawn`) starts its program again the moment its serve is stopped;
//   · Homebrew's service cannot listen while another serve holds the port.
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
    if (!serving) { req.socket.destroy(); return; }   // nothing listens: the connection is refused
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
export interface Serve { pid: number; path: string; version: string; by: 'app' | 'brew-service' | 'unsupervised'; foreign?: boolean }

export type Mac = OllamaHost & {
  running: Serve | null;
  disk: { formula: string | null; app: string | null; appCask: string | null };
  /** What `brew` would install now (a box where Homebrew has nothing newer: the version already on disk). */
  latest: string;
  env: Record<string, string>;
  brews: string[][]; setenvs: string[]; terms: number[]; launches: number; serviceRestarts: number;
  heldDuringBrew: boolean[]; downAtBrew: boolean[];
  hasBrewInstalled: boolean; failBrew: boolean; failBrewOnce: boolean; cliOk: boolean; serviceWorks: boolean;
  relaunchGate: Promise<void>;
  /** A supervisor that starts this program again whenever its serve stops (a launchd job of the owner's). `program` null:
   *  the formula's link, so the program on disk then. */
  respawn: { program: string | null; version?: string } | null;
};

let nextPid = 800;
export function fakeMac(o: { running?: Serve | null; formula?: string | null; app?: string | null; appCask?: string | null } = {}): Mac {
  let serve: Serve | null = null;
  const stop = (): void => {
    m.running = null;
    if (m.respawn) {
      const v = m.respawn.version ?? m.disk.formula ?? 'none';
      m.running = { pid: nextPid++, path: m.respawn.program ?? cellar(v), version: v, by: 'unsupervised' };
    }
  };
  const m: Mac = {
    get running() { return serve; },
    set running(v: Serve | null) { serve = v; ollama.serving = v ? { version: v.version } : null; },
    disk: { formula: o.formula ?? null, app: o.app ?? null, appCask: o.appCask === undefined ? (o.app ? 'ollama-app' : null) : o.appCask },
    latest: LATEST, env: {},
    brews: [], setenvs: [], terms: [], launches: 0, serviceRestarts: 0, heldDuringBrew: [], downAtBrew: [],
    hasBrewInstalled: true, failBrew: false, failBrewOnce: false, cliOk: true, serviceWorks: true, relaunchGate: Promise.resolve(), respawn: null,
    getenv: async (k) => m.env[k] ?? null,
    setenv: async (k, v) => { m.env[k] = v; m.setenvs.push(`${k}=${v}`); },
    listener: async () => (serve ? { pid: serve.pid, path: serve.path } : null),
    appPids: async () => (serve?.by === 'app' ? [APP_PID] : []),
    appInstalled: async () => m.disk.app !== null,
    terminate: (pid) => {
      m.terms.push(pid);
      if (serve && !serve.foreign && (pid === serve.pid || (serve.by === 'app' && pid === APP_PID))) stop();
    },
    alive: (pid) => !!serve && (pid === serve.pid || (serve.by === 'app' && pid === APP_PID)),
    launchApp: async () => {
      await m.relaunchGate; m.launches++;
      if (m.disk.app && !serve) m.running = { pid: nextPid++, path: APP_PROGRAM, version: m.disk.app, by: 'app' };
    },
    answers: async () => !!serve,
    sleep: async () => undefined,
    brewServicePid: async () => (serve?.by === 'brew-service' ? serve.pid : null),
    hasBrew: async () => m.hasBrewInstalled,
    brewCaskToken: async () => m.disk.appCask,
    brewFormulaInstalled: async () => m.disk.formula !== null,
    cliRuns: async () => m.cliOk,
    brew: async (args) => {
      m.brews.push(args); m.heldDuringBrew.push(localHeld()); m.downAtBrew.push(!serve);
      if (m.failBrewOnce) { m.failBrewOnce = false; throw new Error('brew hiccup (raw)'); }
      if (m.failBrew) throw new Error('Error: brew exploded (raw)');
      // The program ON DISK only: whatever serves keeps running the program it started with.
      if (args.includes('--cask')) { m.disk.app = m.latest; m.disk.appCask = args[args.length - 1]; } else m.disk.formula = m.latest;
    },
    restartBrewService: async () => {
      m.serviceRestarts++;
      if (!m.disk.formula) throw new Error('Error: No available formula with the name "ollama" (raw)');
      if (serve?.by === 'brew-service') m.running = null;
      if (serve || !m.serviceWorks) return;   // another serve holds the port (or it crashes at start): launchd's job cannot listen
      m.running = { pid: nextPid++, path: cellar(m.disk.formula), version: m.disk.formula, by: 'brew-service' };
    },
  };
  m.running = o.running ?? null;
  return m;
}

/** A serve nothing supervises, from the formula's program at `version` (the 3.4.1 Dojo's `exec('ollama serve')`, a shell's). */
export const formulaServe = (version: string, extra: Partial<Serve> = {}): Serve => ({ pid: 500, path: cellar(version), version, by: 'unsupervised', ...extra });
export const appServe = (version: string): Serve => ({ pid: 500, path: APP_PROGRAM, version, by: 'app' });
export const serviceServe = (version: string): Serve => ({ pid: 500, path: cellar(version), version, by: 'brew-service' });
