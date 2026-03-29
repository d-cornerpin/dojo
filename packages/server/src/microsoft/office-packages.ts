// ════════════════════════════════════════
// Office Package Installer & Availability Check
// Installs docx, xlsx, pptxgenjs on demand when Microsoft connects
// ════════════════════════════════════════

import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';

const logger = createLogger('office-packages');

const REQUIRED_PACKAGES = ['docx', 'xlsx', 'pptxgenjs'];

let installStatus: 'not_installed' | 'installing' | 'installed' | 'failed' = 'not_installed';
let installError: string | null = null;

// ── Availability Check ──

let packagesVerified = false;

export function areOfficePackagesInstalled(): boolean {
  if (packagesVerified) return true;

  // Check if the packages exist in node_modules by looking for their package.json
  for (const pkg of REQUIRED_PACKAGES) {
    const pkgPath = path.resolve(process.cwd(), 'node_modules', pkg, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
  }

  packagesVerified = true;
  return true;
}

export function resetPackageCache(): void {
  packagesVerified = false;
}

export function checkAndUpdateStatus(): void {
  if (areOfficePackagesInstalled()) {
    installStatus = 'installed';
    installError = null;
  } else if (installStatus === 'installed') {
    // Was installed but packages are gone
    installStatus = 'not_installed';
  }
}

export function getInstallStatus(): { status: typeof installStatus; error: string | null } {
  return { status: installStatus, error: installError };
}

// ── Background Installer ──

export function installOfficePackages(): void {
  if (installStatus === 'installing') {
    logger.info('Office package install already in progress');
    return;
  }

  if (areOfficePackagesInstalled()) {
    installStatus = 'installed';
    installError = null;
    broadcast({ type: 'microsoft:office_packages', data: { status: 'installed' } } as never);
    logger.info('Office packages already installed');
    return;
  }

  installStatus = 'installing';
  installError = null;
  broadcast({ type: 'microsoft:office_packages', data: { status: 'installing' } } as never);

  logger.info('Installing Office packages: docx, xlsx, pptxgenjs');

  const cwd = process.cwd();
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin');
  const extendedPath = [npmGlobalBin, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].join(':');

  exec(
    `npm install ${REQUIRED_PACKAGES.join(' ')} --save`,
    {
      cwd,
      timeout: 120000,
      env: { ...process.env, PATH: extendedPath },
    },
    (err, stdout, stderr) => {
      if (err) {
        installStatus = 'failed';
        installError = err.message;
        logger.error('Office package install failed', { error: err.message, stderr });
        broadcast({ type: 'microsoft:office_packages', data: { status: 'failed', error: err.message } } as never);
        return;
      }

      // Reset cache and verify
      resetPackageCache();
      if (areOfficePackagesInstalled()) {
        installStatus = 'installed';
        installError = null;
        logger.info('Office packages installed successfully');
        broadcast({ type: 'microsoft:office_packages', data: { status: 'installed' } } as never);
      } else {
        installStatus = 'failed';
        installError = 'Packages installed but not resolvable';
        logger.error('Office packages installed but not resolvable');
        broadcast({ type: 'microsoft:office_packages', data: { status: 'failed', error: installError } } as never);
      }
    },
  );
}
