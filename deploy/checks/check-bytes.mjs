#!/usr/bin/env node
// ════════════════════════════════════════
// Byte-hygiene gate (Phase 0 T1).
//
// Refuses tracked source containing bytes that make files invisible or
// deceptive to text tooling:
//   - NUL and C0 controls (except \t \n \r): plain grep treats the file as
//     BINARY and silently reports no match — this is how the dev-instrument
//     ship gate spent months blind to the two largest files in the tree.
//   - DEL (0x7F).
//   - Unicode bidi overrides / isolates (U+202A-202E, U+2066-2069) and
//     zero-width characters (U+200B-200D): render-time deception.
//
// Usage:
//   node deploy/checks/check-bytes.mjs            # all tracked source
//   node deploy/checks/check-bytes.mjs --staged   # staged files (pre-commit)
// Exit 1 on any finding, with file/offset/line/hex context.
// ════════════════════════════════════════
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const BAD_BYTE = (b) =>
  b <= 0x08 || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f) || b === 0x7f;
const BAD_UNI = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D]/;

const staged = process.argv.includes('--staged');
const cmd = staged
  ? 'git diff --cached --name-only --diff-filter=ACM'
  : "git ls-files '*.ts' '*.tsx' '*.mjs' '*.js' '*.sh' '*.sql' '*.md'";

let findings = 0;
for (const f of execSync(cmd, { encoding: 'utf8' }).split('\n').filter(Boolean)) {
  if (!fs.existsSync(f)) continue;
  if (staged && !/\.(ts|tsx|mjs|js|sh|sql|md)$/.test(f)) continue;
  const buf = fs.readFileSync(f);
  let line = 1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0a) line++;
    if (BAD_BYTE(b)) {
      findings++;
      const ctx = buf.subarray(Math.max(0, i - 20), i + 20);
      console.error(`${f}: byte 0x${b.toString(16).padStart(2, '0')} at offset ${i} (line ${line})`);
      console.error(`  context: ${JSON.stringify(ctx.toString('latin1'))}`);
    }
  }
  const text = buf.toString('utf8');
  if (BAD_UNI.test(text)) {
    findings++;
    console.error(`${f}: bidi/zero-width unicode character present`);
  }
}

if (findings) {
  console.error(`\n✗ byte hygiene: ${findings} finding(s). These bytes blind grep or deceive review.`);
  process.exit(1);
}
console.log('✓ byte hygiene clean');
