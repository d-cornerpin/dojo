// ════════════════════════════════════════════════════════════════════════════════════════
// RULINGS AUDIT #7 (owner, M11, verbatim): "It shouldn't be a persistent notification if it doesn't require the
// intervention of the user. It also shouldn't be red."
//
// Every chat:error frame the server sends with severity `error` is a sticky red card in the chat (Chat.tsx). So every
// one of them DECLARES its class, `cardClass: 'action'` (the owner must act: reconnect, top up, pick a model, a paused
// agent) or `'informational'` (news; the dashboard shows it as a warning that leaves by itself). The table below is the
// record of each site's decision; a new site, or a changed one, fails here until someone classifies it.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ENGINE_STEPS_REL } from '../agent/v2/__tests__/engine-sources.js';

const SRC = path.resolve(__dirname, '..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

interface Site { severity: string; cardClass: string | null }

/** Every chat:error frame that can carry severity `error`, by file, in source order: [severity, cardClass] as written. */
const DECLARED: Record<string, Array<[string, string]>> = {
  'agent/errors.ts': [["'error'", "'action'"]],                                    // paused after repeated errors
  'agent/runtime.ts': [["toastCode === 'NO_MODEL' ? 'error' : 'warning'", "toastCode === 'NO_MODEL' ? 'action' : 'informational'"]],
  'agent/v2/recovery.ts': [
    ["'error'", "'action'"],                                                       // a platform lock: account, quota, network
    ["paused ? 'error' : 'warning'", "paused ? 'action' : 'informational'"],       // "the Healer is looking into it" is news
  ],
  [`${ENGINE_STEPS_REL}/call-llm/no-pick-holds.ts`]: [["stopOnly ? 'warning' : 'error'", "stopOnly ? 'informational' : 'action'"]],
  'google/reauth-notice.ts': [["'error'", "'action'"]],                            // reconnect the Google account
  'healer/injury-recovery.ts': [["severity", "severity === 'error' ? 'action' : 'informational'"]],   // the Healer broken or missing
  'memory/window-starvation-card.ts': [["'error'", "'action'"]],                   // a bigger model or fewer tools
  'plaud/auth.ts': [["'error'", "'action'"]],                                      // sign in to Plaud again
  'providers/billing-breaker.ts': [["'error'", "'action'"]],                       // top up or change the key
  'services/watcher-status.ts': [["'error'", "'action'"]],                         // reconnect the account
};
/** Not this census's: the debug toast route (developer-only, sends whatever severity the request names), and the
 *  platform owner-card door, whose callers declare their class in the t138 owner-card census. */
const NOT_OWNER: ReadonlySet<string> = new Set(['gateway/routes/system.ts', 'services/owner-card-frames.ts']);

function sites(): Record<string, Site[]> {
  const out: Record<string, Site[]> = {};
  for (const f of sources(SRC)) {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    if (NOT_OWNER.has(rel)) continue;
    const src = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        const get = (k: string) => n.properties.find((q): q is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
          (ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) && ts.isIdentifier(q.name) && q.name.text === k);
        const type = get('type');
        if (type && ts.isPropertyAssignment(type) && ts.isStringLiteralLike(type.initializer) && type.initializer.text === 'chat:error') {
          const sev = get('severity');
          const sevText = sev ? (ts.isPropertyAssignment(sev) ? sev.initializer.getText(src) : sev.name.text) : '';
          const cls = get('cardClass');
          const clsText = cls ? (ts.isPropertyAssignment(cls) ? cls.initializer.getText(src) : cls.name.text) : null;
          // `severity` may be a parameter (injury-recovery passes it through): it can be 'error', so it is a site.
          if (/'error'/.test(sevText) || sevText === 'severity') (out[rel] ??= []).push({ severity: sevText, cardClass: clsText });
        }
      }
      n.forEachChild(visit);
    };
    visit(src);
  }
  return out;
}

describe('every sticky red card asks for the owner\'s action (audit #7)', () => {
  const found = sites();

  it('every chat:error that can be severity `error` declares its class', () => {
    const undeclared = Object.entries(found).flatMap(([rel, ss]) => ss.filter((s) => s.cardClass === null).map(() => rel));
    expect(undeclared).toEqual([]);
  });

  it('the decisions are the declared ones, site by site', () => {
    const actual: Record<string, Array<[string, string]>> = {};
    for (const [rel, ss] of Object.entries(found)) actual[rel] = ss.map((s) => [s.severity, s.cardClass ?? '']);
    expect(actual).toEqual(DECLARED);
  });

  it('"the Healer is looking into it" is never sticky and red', () => {
    const recovery = fs.readFileSync(path.join(SRC, 'agent/v2/recovery.ts'), 'utf8');
    expect(recovery).toMatch(/the Healer is looking into it/);
    expect(found['agent/v2/recovery.ts']?.[1]).toEqual({ severity: "paused ? 'error' : 'warning'", cardClass: "paused ? 'action' : 'informational'" });
  });
});
