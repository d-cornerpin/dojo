import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LogEntry } from '@dojo/shared';

const LOG_DIR = path.join(os.homedir(), '.dojo', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'dojo.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const FLUSH_INTERVAL_MS = 500; // Flush buffer every 500ms
const MAX_BUFFER_SIZE = 50; // Flush if buffer exceeds this many entries

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLogLevel: LogLevel = 'info';
// Only broadcast warn/error to dashboard (not every info line)
let logBroadcastCallback: ((entry: LogEntry) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function setLogBroadcast(callback: (entry: LogEntry) => void): void {
  logBroadcastCallback = callback;
}

// ── Buffered async writer ──

let writeBuffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let logDirChecked = false;
let lastRotateCheck = 0;

function ensureLogDir(): void {
  if (logDirChecked) return;
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  logDirChecked = true;
}

function rotateIfNeeded(): void {
  // Only check rotation every 60 seconds
  const now = Date.now();
  if (now - lastRotateCheck < 60_000) return;
  lastRotateCheck = now;

  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const rotatedPath = LOG_FILE + '.1';
      if (fs.existsSync(rotatedPath)) {
        fs.unlinkSync(rotatedPath);
      }
      fs.renameSync(LOG_FILE, rotatedPath);
    }
  } catch {
    // File doesn't exist yet, nothing to rotate
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

  // Async write — doesn't block the event loop
  fs.appendFile(LOG_FILE, lines, 'utf-8', (err) => {
    if (err) {
      // Last resort: stderr (don't recurse into logger)
      process.stderr.write(`Logger write error: ${err.message}\n`);
    }
  });
}

function writeEntry(entry: LogEntry): void {
  const line = JSON.stringify(entry) + '\n';
  writeBuffer.push(line);

  // Broadcast only warn/error to dashboard (not info/debug — too noisy)
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
