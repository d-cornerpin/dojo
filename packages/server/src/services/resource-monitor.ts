// ════════════════════════════════════════
// Resource Monitor: Memory + Spawn Gating
// ════════════════════════════════════════

import os from 'node:os';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from './imessage-bridge.js';

const logger = createLogger('resource-monitor');

const MIN_FREE_MEMORY_MB = 1024; // 1GB
let lastWarningTime = 0;
const WARNING_COOLDOWN_MS = 60000; // 1 minute between warnings

export interface ResourceInfo {
  memory: {
    total: number;  // MB
    used: number;   // MB
    free: number;   // MB
  };
  cpu: {
    loadAvg: number[];
  };
}

export function getResourceInfo(): ResourceInfo {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    memory: {
      total: Math.round(totalMem / (1024 * 1024)),
      used: Math.round(usedMem / (1024 * 1024)),
      free: Math.round(freeMem / (1024 * 1024)),
    },
    cpu: {
      loadAvg: os.loadavg(),
    },
  };
}

export function canSpawnAgent(): { allowed: boolean; reason?: string } {
  const info = getResourceInfo();

  if (info.memory.free < MIN_FREE_MEMORY_MB) {
    const now = Date.now();
    if (now - lastWarningTime > WARNING_COOLDOWN_MS) {
      lastWarningTime = now;

      logger.warn('Low memory warning', {
        freeMb: info.memory.free,
        totalMb: info.memory.total,
        threshold: MIN_FREE_MEMORY_MB,
      });

      broadcast({
        type: 'resource:warning',
        data: {
          type: 'memory',
          freeMb: info.memory.free,
          totalMb: info.memory.total,
          threshold: MIN_FREE_MEMORY_MB,
        },
      } as never);

      // Critical iMessage alert when memory drops below 512MB
      if (info.memory.free < 512) {
        sendAlert('Critical: System memory below 512MB. Terminate idle sub-agents.', 'critical');
      }
    }

    return {
      allowed: false,
      reason: `Insufficient memory: ${info.memory.free}MB free (minimum ${MIN_FREE_MEMORY_MB}MB required)`,
    };
  }

  return { allowed: true };
}
