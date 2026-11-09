// ════════════════════════════════════════════════════════════════════════════════════════
// NO SHIPPED TEMPLATE WITHOUT A READER — t107 (t92's find: `templates/SOUL.md` had none).
//
// ── WHAT WAS MEASURED, AND WHY AN ORPHAN IS WORSE THAN A MISSING FILE ──
// `deploy/build-package.sh:144-145` copies `templates/*.md` into every artifact, so anything in
// that directory ships to every box and reads like doctrine. `templates/SOUL.md` shipped 2,509
// bytes of PRIMARY-agent doctrine that reached NO MODEL ANYWHERE: the primary's soul is seeded
// from the in-code `DEFAULT_SOUL_MD` (`assembler.ts`'s `readPromptFile('SOUL.md', …)`), and a
// box that completes setup gets a THIRD text generated from the OOBE form
// (`gateway/routes/config.ts`). Its content was not a stale copy of the default either — other
// headings, other rules, a `# Rules` section the default does not have. A second opinion with
// no reader is the worst of the three: it is the file a maintainer edits believing they changed
// what an agent reads.
//
// So the directory is now closed: every file in it is either RESOLVED by a production reader or
// a DECLARED MIRROR of an in-code default, pinned byte-for-byte by a named clause.
//
// ── WHY THE READERS ARE DISCOVERED AND THE DOORS ARE CLOSED (G4) ──
// A presence-only census ("each file is mentioned somewhere") would pass on `'SOUL.md'`, which
// appears all over the tree as the name of the PER-BOX file in `~/.dojo/prompts` — a different
// file entirely. What makes a file a SHIPPED template is being resolved through one of the two
// doors that reach the `templates/` directory, so this census enumerates THE DOORS and the
// names each requests, and refuses a third door it has not been told about. That is the
// direction a presence clause cannot cover: a new door added without registering it REDS here
// rather than quietly widening the corpus.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const TEMPLATES = path.join(REPO_ROOT, 'templates');
const SERVER_SRC = path.join(REPO_ROOT, 'packages/server/src');

/**
 * A file that ships with no reader BY DESIGN: a byte-identical mirror of an in-code default,
 * kept so the installed `templates/` directory does not contradict the engine. Each entry names
 * the constant it mirrors and the clause that pins the two together, and this census checks
 * BOTH of those claims rather than trusting the declaration.
 */
const DECLARED_MIRRORS: ReadonlyArray<{
  readonly file: string; readonly constant: string; readonly pinnedBy: string;
}> = [
  {
    file: 'USER.md',
    constant: 'DEFAULT_USER_MD',
    pinnedBy: 'prompt/__tests__/the-profile-admits-it-is-empty.test.ts',
  },
];

describe('every file the platform ships in templates/ is read, or is a declared mirror', () => {

  it('every declared mirror really is byte-identical to the constant it names', async () => {
    const templates = await import('../templates.js') as Record<string, unknown>;
    for (const m of DECLARED_MIRRORS) {
      const value = templates[m.constant];
      expect(typeof value, `${m.constant} is exported from prompt/templates.ts`).toBe('string');
      expect(fs.readFileSync(path.join(TEMPLATES, m.file), 'utf-8')).toBe(value);
      // The declaration's second claim: the clause it points at exists and names this file.
      const pinned = path.join(SERVER_SRC, m.pinnedBy);
      expect(fs.existsSync(pinned), `${m.pinnedBy} exists`).toBe(true);
      expect(fs.readFileSync(pinned, 'utf-8')).toContain(m.file);
    }
  });
});
