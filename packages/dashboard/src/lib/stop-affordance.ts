// ════════════════════════════════════════════════════════════════════════════
// WHEN THE STOP BUTTON IS OFFERED, AND WHAT IT SAYS (A-5b)
//
// A-5 made the owner's stop reach every media dial; A-6 made it reach the web and
// workspace transports. Neither made the work VISIBLE. The card gated its Stop
// button on `status === 'working'`, and a background media job — a video render, a
// narration, an image delivery that deliberately waits for the agent to go idle —
// runs while the row reads `idle`. So the button was withheld for exactly the work
// it would have cut, and the owner's ruling ("the button stops ALL of that agent's
// activity") was true underneath and invisible on top.
//
// ── WHY A LIB FILE AND NOT A TERNARY IN THE CARD ──
// A component runner landed on 2026-09-26; the arrangement it does not replace is that a
// decision worth arguing with lives here as a pure function and is driven from the
// server suite (`report-edits.ts`, `github-card.ts`, `access-edits.ts` and five
// others do exactly this). "Is there work to stop, and what do I call it" is such a
// decision: it is the whole of A-5b's user-facing half.
//
// ── THE THREE RULES, AND THE ONE THAT IS A JUDGEMENT ──
//  1. WORKING MEANS STOPPABLE, always — that is the pre-A-5b behaviour and it is
//     unchanged, including on a server too old to send `inFlight` at all.
//  2. BACKGROUND WORK MEANS STOPPABLE TOO, whatever the status says. This is the
//     defect, fixed.
//  3. TERMINATED IS NEVER STOPPABLE. A terminated agent cannot be sent anything,
//     and offering a button that would do nothing is the same untruth in reverse.
//
// ⚠ AND ONE THING THIS FILE DELIBERATELY DOES NOT DECIDE. The BACKLOG entry asks
// for "an owner ruling on what stopping an idle agent means for its proactive lane"
// — i.e. whether stopping a background render should also quiet the agent's own
// scheduled work. That is a product ruling, not a rendering rule, so it is not
// invented here: this file offers the button for work that is measurably in flight
// and says what it will cut, and nothing more.
// ════════════════════════════════════════════════════════════════════════════

/** The part of an agent payload this decision reads. Structural, so the card, a test
 *  fixture and a future list endpoint can all be its subject. */
export interface StopSubject {
  status: string;
  /** Live registry counts. `undefined` = an older server made no claim (rule 1 only). */
  inFlight?: { turn: number; background: number };
}

export interface StopAffordance {
  /** Offer the button at all? */
  show: boolean;
  /** What the button says. Never a name, never a provider's wording. */
  label: string;
  /** One line the surface may show beside it — why there is something to stop. */
  why: string;
}

const NOTHING: StopAffordance = { show: false, label: 'Stop', why: '' };

/**
 * Should this agent be offered a stop, and what should it say?
 *
 * The counts are read as CLAIMS, not as truth about the future: by the time a click
 * lands the job may have finished, and the stop route is idempotent, so a button
 * offered one poll too late costs nothing. The opposite error — withholding it while
 * a 30-minute video render burns — is the one this function exists to prevent.
 */
export function stopAffordance(agent: StopSubject): StopAffordance {
  if (agent.status === 'terminated') return NOTHING;

  const turn = agent.inFlight?.turn ?? 0;
  const background = agent.inFlight?.background ?? 0;
  const working = agent.status === 'working';

  if (working) {
    // A working agent is stoppable whatever the counts say — including on a server
    // that sends no counts at all. Naming the background work when there IS some is
    // the difference between "stop this" and "stop this AND the render behind it".
    return background > 0
      ? {
        show: true,
        label: 'Stop',
        why: background === 1
          ? 'Working, and one background job is still running. Stop cuts both.'
          : `Working, and ${background} background jobs are still running. Stop cuts all of them.`,
      }
      : { show: true, label: 'Stop', why: 'Working right now.' };
  }

  if (background > 0) {
    // ── THE A-5b CASE ──
    // The turn is over, the row says idle, and something the button would cut is on
    // the wire. The label says background so the owner knows what they are stopping
    // — pressing "Stop" on an idle-looking agent is otherwise a mystery action.
    return {
      show: true,
      label: background === 1 ? 'Stop background job' : 'Stop background jobs',
      why: background === 1
        ? 'One job is still running in the background after the turn ended.'
        : `${background} jobs are still running in the background after the turn ended.`,
    };
  }

  // A turn-scoped call with a status that is not `working` is a race, not a state: the
  // status write and the registry are not one transaction. Offering the button is the
  // honest side of that race — there IS a call the stop would cut.
  if (turn > 0) {
    return { show: true, label: 'Stop', why: 'A call is still in flight for this agent.' };
  }

  return NOTHING;
}
