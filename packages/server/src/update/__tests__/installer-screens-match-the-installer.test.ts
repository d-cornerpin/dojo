// The .pkg's welcome/conclusion screens and the README written into the zip must
// say what install.sh actually does: one port, and the 16 GB floor. A screen that
// points at a port nothing listens on, or names a RAM number the installer no longer
// checks, is a lie a person reads during install.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPLOY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy');
const installSh = fs.readFileSync(path.join(DEPLOY, 'install.sh'), 'utf-8');
const welcomeHtml = fs.readFileSync(path.join(DEPLOY, 'pkg-resources/welcome.html'), 'utf-8');
const conclusionHtml = fs.readFileSync(path.join(DEPLOY, 'pkg-resources/conclusion.html'), 'utf-8');
const buildPackage = fs.readFileSync(path.join(DEPLOY, 'build-package.sh'), 'utf-8');

// install.sh's single port is the source of truth for every screen that shows a URL.
const port = /^DOJO_PORT=(\d+)/m.exec(installSh)?.[1];
expect(port).toBe('3001');

// The README written into the zip is the text of build-package.sh's heredoc, between the
// line that opens it (<< 'READMEEOF') and the next line that is exactly the delimiter.
function readmeHeredoc(src: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.includes("<< 'READMEEOF'"));
  const end = lines.findIndex((l, i) => i > start && l === 'READMEEOF');
  if (start < 0 || end < 0) throw new Error('build-package.sh no longer has its README heredoc where this test reads it');
  return lines.slice(start + 1, end).join('\n');
}

describe('the installer screens match the installer', () => {
  it('welcome.html states the 16 GB floor, not 8 GB', () => {
    expect(welcomeHtml).toContain('16GB');
    expect(welcomeHtml).not.toContain('8GB');
  });

  it('conclusion.html points at the installer port, not 3000', () => {
    expect(conclusionHtml).toContain(`http://localhost:${port}`);
    expect(conclusionHtml).not.toContain('localhost:3000');
  });

  it('the README in build-package.sh points at the installer port and the 16 GB floor', () => {
    const readme = readmeHeredoc(buildPackage);
    expect(readme).toContain(`http://localhost:${port}`);
    expect(readme).not.toContain('localhost:3000');
    expect(readme).toContain('16GB');
  });
});
