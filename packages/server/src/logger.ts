import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry } from '@dojo/shared';
import { homeDir } from './home.js';
import { rotateLogFile } from './log-rotation.js';

const LOG_DIR = path.join(homeDir(), '.dojo', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'dojo.log');
const FLUSH_INTERVAL_MS = 500; // Flush buffer every 500ms
const MAX_BUFFER_SIZE = 50; // Flush if buffer exceeds this many entries

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLogLevel: LogLevel = 'info';
// Only broadcast warn/error to dashboard (not every info line)
let logBroadcastCallback: ((entry: LogEntry) => void) | null = null;

export function setLogBroadcast(callback: (entry: LogEntry) => void): void {
  logBroadcastCallback = callback;
}

// ── Buffered async writer ──

let writeBuffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastRotateCheck = 0;

/** Made on every flush: the folder can vanish under a running server (cleared by hand, or replaced by an import).
 *  Never throws: a folder that cannot be made shows as the write's own stderr line. */
function ensureLogDir(): void {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* the write below reports it */ }
}

function rotateIfNeeded(): void {
  // Only check rotation every 60 seconds
  const now = Date.now();
  if (now - lastRotateCheck < 60_000) return;
  lastRotateCheck = now;

  try {
    rotateLogFile(LOG_FILE, now);
  } catch {
    // Rotation is never worth losing a log line over.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushBuffer();
  }, FLUSH_INTERVAL_MS);
}

function flushBuffer(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (writeBuffer.length === 0) return;

  const lines = writeBuffer.join('');
  writeBuffer = [];

  ensureLogDir();
  rotateIfNeeded();
  // Async, so the event loop is never blocked; stderr is the last resort (the logger never logs about itself).
  fs.appendFile(LOG_FILE, lines, 'utf-8', (err) => {
    if (err) process.stderr.write(`Logger write error: ${err.message}\n`);
  });
}

/** Serialise one entry to a JSON line without ever throwing.
 *
 *  The common case stays a bare `JSON.stringify`, byte for byte. Only when that
 *  throws (a BigInt in `meta`, or a value reached twice on the way down, a cycle),
 *  do we retry through a replacer that renders a BigInt as its decimal string and a
 *  seen object as `[Circular]`. If even that throws, we keep just the fields this
 *  logger controls, still opening with `{"timestamp":"` so log rotation recognises
 *  the line as its own. */
function serializeEntry(entry: LogEntry): string {
  try {
    return JSON.stringify(entry);
  } catch {
    const seen = new WeakSet<object>();
    const replacer = (_key: string, value: unknown): unknown => {
      if (typeof value === 'bigint') return value.toString();
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    };
    try {
      return JSON.stringify(entry, replacer);
    } catch {
      return JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        component: entry.component,
        message: entry.message,
        meta: '[unserializable]',
      });
    }
  }
}

function writeEntry(entry: LogEntry): void {
  const line = serializeEntry(entry) + '\n';
  writeBuffer.push(line);

  // Broadcast only warn/error to dashboard (not info/debug, too noisy)
  if (logBroadcastCallback && (entry.level === 'warn' || entry.level === 'error')) {
    try {
      logBroadcastCallback(entry);
    } catch {
      // Don't let broadcast failures affect logging
    }
  }

  // Flush immediately if buffer is large, otherwise schedule
  if (writeBuffer.length >= MAX_BUFFER_SIZE) {
    flushBuffer();
  } else {
    scheduleFlush();
  }
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLogLevel];
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>, agentId?: string): void;
  info(message: string, meta?: Record<string, unknown>, agentId?: string): void;
  warn(message: string, meta?: Record<string, unknown>, agentId?: string): void;
  error(message: string, meta?: Record<string, unknown>, agentId?: string): void;
}

export function createLogger(component: string): Logger {
  const log = (level: LogLevel, message: string, meta?: Record<string, unknown>, agentId?: string): void => {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...(agentId ? { agentId } : {}),
      ...(meta ? { meta } : {}),
    };

    writeEntry(entry);
  };

  return {
    debug: (message, meta?, agentId?) => log('debug', message, meta, agentId),
    info: (message, meta?, agentId?) => log('info', message, meta, agentId),
    warn: (message, meta?, agentId?) => log('warn', message, meta, agentId),
    error: (message, meta?, agentId?) => log('error', message, meta, agentId),
  };
}

// Flush on process exit
process.on('exit', () => {
  if (writeBuffer.length > 0) {
    // Sync write only on shutdown
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, writeBuffer.join(''), 'utf-8');
    writeBuffer = [];
  }
});

/** The log as it stands, oldest first: the one rotated backup
 *  (`log-rotation.ts` keeps exactly `dojo.log.1`), then the live file plus the lines this
 *  process has buffered but not yet written. Reads only; a missing file reads as empty. */
export function readLogFiles(): string[] {
  const read = (f: string): string => { try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; } };
  return [read(`${LOG_FILE}.1`), read(LOG_FILE) + writeBuffer.join('')];
}

export function readLogEntries(options?: {
  limit?: number;
  level?: LogLevel;
  component?: string;
}): LogEntry[] {
  const limit = options?.limit ?? 100;
  const levelFilter = options?.level;
  const componentFilter = options?.component;

  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const entries: LogEntry[] = [];
    // Read from end for most recent first
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]) as LogEntry;
        if (levelFilter && entry.level !== levelFilter) continue;
        if (componentFilter && entry.component !== componentFilter) continue;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  } catch {
    return [];
  }
}
