// UX-REPAIR ROUND 11 — T43b. THE COMPILE STEER INSTRUCTS VERIFICATION.
//
// ── THE INCIDENT (round-11 S5-A, second half) ────────────────────────────────────────────
// BehaviorBot fanned out two research streams. kelly — the PM, no web tools (T43a) — could
// not do hers, so she sent a HAND-OFF note ("kevin is picking this up"), delivery `55ea3858`,
// `send_to_agent`/`a2a`. That note is a non-empty, non-FAIL terminal reply, so `landPiece`
// settled her piece `done`; `join_complete {"landed":2,"outcome":"compile"}` followed at
// 01:19:49 with ONE research stream actually in hand, and this steer then told the model the
// pieces were back. Measured cost: ~6m20s from "pieces back" to answer, recovered only when
// the model improvised — it asked kevin directly and a `join_redrive` caught the result.
//
// ── WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────
// It makes that improvised rescue the INSTRUCTED path. The MODEL judges whether a piece is
// the deliverable its stream was asked for — that judgment is the model's to make and is
// allowed; the engine still only counts structure and classifies no prose. This is the whole
// of leg (b): text, on the events lane, 0 prefix bytes.
//
// NOT DONE, and recorded in the plan's own NOT-DOING list: the verb fix. "Only COMPLETE
// settles a piece" was killed by measurement — `a2a_replies` intents on the dev body are
// ANSWER 341 / DELIVERABLE 262 / COMPLETE 42 / FAIL 2, so real deliverables overwhelmingly
// arrive as ANSWER or DELIVERABLE and that rule would break the dominant working flow.
//
// ── THE NO-TOOLS RULE IS NOT WEAKENED, IT IS CARVED ──────────────────────────────────────
// The steer forbids tools because an earlier wording ("verify each piece's ACTUAL content")
// sent the floor model into a blocked exec loop and 45 tool calls (run bmrplgdg33l). That
// sentence is untouched, byte for byte. The new paragraph names ITSELF as the single
// exception and bounds it to ONE `send_to_agent` in ONE situation, so there is no reading on
// which "go look things up" is back.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSteerText, JOIN_REDRIVE_BOUND } from '../join-drive.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PIECES = [
  'Piece 1 (from Kelly, thread 55ea3858): "I don\'t have web access for this one — kevin is picking it up."',
  'Piece 2 (from Kevin, thread 34430191): "Native shrubs for a Denver north-facing bed: ..."',
];

const steer = (attempt: number | null = null): string =>
  compileSteerText({ total: 2, pieces: PIECES, attempt, bound: JOIN_REDRIVE_BOUND });

describe('the compile steer tells the model to check the pieces are the deliverables', () => {
  it('it names the check: is this piece the deliverable that stream was asked for', () => {
    const t = steer();
    expect(t).toMatch(/deliverable that stream was asked for/);
  });

  it('it names the shape that broke the round-11 join: a hand-off with no result in it', () => {
    const t = steer();
    expect(t).toMatch(/hand-off/);
    expect(t, 'and says plainly what a hand-off means').toMatch(/is NOT back/);
  });

  it('it instructs OBTAINING the missing stream directly, before compiling', () => {
    const t = steer();
    expect(t).toMatch(/send_to_agent/);
    expect(t, 'from whoever the hand-off names').toMatch(/the agent it names/);
    expect(t, 'and the order of operations is stated').toMatch(/compile after it arrives/);
  });

  it('and it forbids passing a hand-off note off as the answer', () => {
    expect(steer()).toMatch(/Do not present a hand-off note to the owner as if it were the answer/);
  });
});

describe('the carve-out is narrow, and everything incident-derived is carried', () => {
  it('the no-tools sentence is still there, byte for byte', () => {
    expect(steer()).toContain(
      'Do NOT search, open files, run commands, or call any tools first — not the tracker, '
      + 'not the vault, not a peer notification; everything you need is quoted below.',
    );
  });

  it('the new paragraph names itself the SINGLE exception, and bounds it to one message', () => {
    const t = steer();
    expect(t).toMatch(/single exception to the no-tools rule above/);
    expect(t, 'exactly one message, not a lookup licence').toMatch(/send ONE send_to_agent message/);
    expect(t, 'and only in the one case').toMatch(/only in that case/);
  });

  it('the verbatim-quoting order and the tracker-row warning are unchanged', () => {
    const t = steer();
    expect(t).toContain('Compose ONE reply to the owner now that carries each piece\'s content exactly as delivered below');
    expect(t).toContain('do not trust a tracker row that says "complete" over the delivered text itself');
    expect(t).toContain('If a piece reads as a failure, say so honestly in the same reply.');
  });

  it('the pieces are still quoted verbatim, after the orders', () => {
    const t = steer();
    expect(t).toContain(PIECES[0]);
    expect(t).toContain(PIECES[1]);
    expect(t.indexOf('Compose ONE reply to the owner now')).toBeLessThan(t.indexOf('Piece 1'));
    expect(t.indexOf('deliverable that stream was asked for')).toBeLessThan(t.indexOf('Piece 1'));
  });

  it('T10 still holds: the unconditional order survives the 400-char events-lane gist', () => {
    // `memory/lanes.ts` caps an EVENTS & NOTICES row at a 400-char gist. T10 put the order
    // ahead of the quotes for that reason, and the new paragraph must not push it back out.
    const t = steer();
    expect(t.indexOf('Compose ONE reply to the owner now')).toBeLessThan(400);
  });

  it('the attempt signal is unchanged in both directions', () => {
    expect(steer(2)).toContain('steer 2 of 3');
    expect(steer(null)).not.toContain('steer');
  });
});

describe('the engine still classifies nothing', () => {
  it('join-drive.ts holds no prose recognizer for hand-offs — the MODEL judges', () => {
    // The banned class, named in the round-11 NOT-DOING list: engine prose-detection of
    // punts/hand-offs. The instruction is text handed to the model; nothing here matches on
    // a reply's words.
    const text = fs.readFileSync(path.resolve(HERE, '../join-drive.ts'), 'utf8');
    const body = text.slice(text.indexOf('export function compileSteerText'));
    expect(body).not.toMatch(/\.test\(|\.match\(|RegExp|includes\(['"]passed/);
  });
});
