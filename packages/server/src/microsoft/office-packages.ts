// Office package installer and availability check (docx, xlsx, pptxgenjs, installed when Microsoft
// connects).

import { exec } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createLogger } from '../logger.js';
import { bumpToolConfigGeneration } from '../agent/tool-config-generation.js';
import { homeDir } from '../home.js';

// Resolver anchored to THIS module, so packages resolve from the hoisted monorepo root in dev (cwd is
// packages/server/) as well as from the install dir in production.
const moduleRequire = createRequire(import.meta.url);

const logger = createLogger('office-packages');

const REQUIRED_PACKAGES = ['docx', 'xlsx', 'pptxgenjs'];

let installStatus: 'not_installed' | 'installing' | 'installed' | 'failed' = 'not_installed';
let installError: string | null = null;

// ── Availability Check ──

let packagesVerified = false;

export function areOfficePackagesInstalled(): boolean {
  if (packagesVerified) return true;

  // Resolve the package's MAIN entry, not ./package.json: `docx` and `pptxgenjs` restrict subpaths via
  // "exports", so ./package.json throws even when the package is installed.
  for (const pkg of REQUIRED_PACKAGES) {
    try {
      moduleRequire.resolve(pkg);
    } catch {
      return false;
    }
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
    bumpToolConfigGeneration(); // office tools drop out of the surface
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
    bumpToolConfigGeneration(); // refresh any list cached before packages resolved
    logger.info('Office packages already installed');
    return;
  }

  installStatus = 'installing';
  installError = null;

  logger.info('Installing Office packages: docx, xlsx, pptxgenjs');

  const cwd = process.cwd();
  const npmGlobalBin = path.join(homeDir(), '.npm-global', 'bin');
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
        return;
      }

      // Reset cache and verify
      resetPackageCache();
      if (areOfficePackagesInstalled()) {
        installStatus = 'installed';
        installError = null;
        bumpToolConfigGeneration(); // office create/edit tools enter the surface
        logger.info('Office packages installed successfully');
      } else {
        installStatus = 'failed';
        installError = 'Packages installed but not resolvable';
        logger.error('Office packages installed but not resolvable');
      }
    },
  );
}
