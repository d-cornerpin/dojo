// The shared lock (~/.dojo/rollback.lock) in restore-db.sh and rollback.sh: taking over the lock of a
// dead holder must be atomic. Clearing it by "check the holder, delete, make a new one" let two or
// three runs started at once all get through. The real `take_lock` text of each script is cut out and
// run by N parallel shells against a lock left by a dead process: exactly one may proceed, every time.
// A holder that exists but belongs to another user (pid 1 here) counts as ALIVE.
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../deploy/scripts');
const DEAD_PID = '2147483646';
const RUNS = 20;
const PARALLEL = 4;

/** The lock functions of a script, exactly as written there. */
function lockText(script: string): string {
  const src = fs.readFileSync(path.join(SCRIPTS, script), 'utf-8');
  const pick = (name: string): string => {
    const start = src.search(new RegExp(`^\\s*${name}\\(\\) \\{`, 'm'));
    if (start < 0) return '';
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 3);
  };
  return `${pick('lock_holder_alive')}\n${pick('take_lock')}`;
}

function harness(text: string): string {
  return `LOCK_DIR="$1"; MARK="$2"\n${text}\nif take_lock; then echo $$ >> "$MARK/proceeded"; sleep 1; rm -rf "$LOCK_DIR"; else echo refused >> "$MARK/refused"; fi\n`;
}

function scratchDir(): string {
  return fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'lock-atomic-'));
}

async function race(script: string, holderPid: string): Promise<{ proceeded: number; refused: number }> {
  const dir = scratchDir();
  try {
    const lock = path.join(dir, 'rollback.lock');
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), holderPid);
    fs.writeFileSync(path.join(dir, 'h.sh'), harness(lockText(script)));
    await Promise.all(Array.from({ length: PARALLEL }, () => new Promise<void>((resolve) => {
      const c = spawn('/bin/bash', [path.join(dir, 'h.sh'), lock, dir], { stdio: 'ignore' });
      c.on('close', () => resolve());
    })));
    const count = (f: string): number => {
      try { return fs.readFileSync(path.join(dir, f), 'utf-8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
    };
    return { proceeded: count('proceeded'), refused: count('refused') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const script of ['restore-db.sh', 'rollback.sh']) {
  describe(`${script} lock`, () => {
    it(`${PARALLEL} parallel runs against a dead holder's lock: exactly one proceeds (x${RUNS})`, async () => {
      for (let i = 0; i < RUNS; i++) {
        const r = await race(script, DEAD_PID);
        expect(r, `round ${i}`).toEqual({ proceeded: 1, refused: PARALLEL - 1 });
      }
    }, 180_000);

    it("a lock held by a process of another user (pid 1) is alive: nobody proceeds", async () => {
      const r = await race(script, '1');
      expect(r).toEqual({ proceeded: 0, refused: PARALLEL });
    }, 30_000);

    it('the run that clears an old takeover marker goes on (no false refusal), and no marker is left', async () => {
      const dir = scratchDir();
      try {
        const lock = path.join(dir, 'rollback.lock'); const marker = `${lock}.takeover`;
        fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), DEAD_PID);
        fs.mkdirSync(marker);
        const old = new Date(Date.now() - 120_000); fs.utimesSync(marker, old, old);
        fs.writeFileSync(path.join(dir, 'h.sh'), harness(lockText(script)));
        const r = spawnSync('/bin/bash', [path.join(dir, 'h.sh'), lock, dir], { encoding: 'utf-8' });
        expect(r.status).toBe(0);
        expect(fs.existsSync(path.join(dir, 'proceeded'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'refused'))).toBe(false);
        expect(fs.existsSync(marker)).toBe(false);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('an old takeover marker beside a FREE lock is cleaned up when the lock is taken', () => {
      const dir = scratchDir();
      try {
        const lock = path.join(dir, 'rollback.lock'); const marker = `${lock}.takeover`;
        fs.mkdirSync(marker);
        const old = new Date(Date.now() - 120_000); fs.utimesSync(marker, old, old);
        fs.writeFileSync(path.join(dir, 'h.sh'), harness(lockText(script)));
        spawnSync('/bin/bash', [path.join(dir, 'h.sh'), lock, dir], { encoding: 'utf-8' });
        expect(fs.existsSync(path.join(dir, 'proceeded'))).toBe(true);
        expect(fs.existsSync(marker)).toBe(false);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('a YOUNG takeover marker beside a free lock is left alone', () => {
      const dir = scratchDir();
      try {
        const lock = path.join(dir, 'rollback.lock'); const marker = `${lock}.takeover`;
        fs.mkdirSync(marker);
        fs.writeFileSync(path.join(dir, 'h.sh'), harness(lockText(script)));
        spawnSync('/bin/bash', [path.join(dir, 'h.sh'), lock, dir], { encoding: 'utf-8' });
        expect(fs.existsSync(marker)).toBe(true);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });
}

