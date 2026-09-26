import * as api from '../lib/api';
import { duplicateQuestion, type DuplicateMatch } from '../lib/report-edits';

// ── WHAT HAPPENED TO THE REPORT — THE TWO PANELS THAT COME AFTER POST (DOJO-REPORT T7) ──
//
// Split out of `ReportPreviewCard.tsx` when the duplicate question arrived: the card was at 235
// lines against the growth detector's 240-line crossing for an unpinned file, and the plan's own
// instruction for that case is SPLIT, never pin. The seam is a real one rather than a line
// budget dressed up — everything here is what the owner sees AFTER the decision, and it decides
// nothing. No `fetch`, no state, no rules; the sentences it shows come from `lib/report-edits.ts`
// where the server's suite can drive them, exactly as the card's own sentence does.
//
// ⚠ THE CONSENT SENTENCES MUST NOT BE COPIED INTO THIS FILE. A second copy is a claim about
// where an owner's words go that nothing checks, and the census in
// `gateway/routes/__tests__/only-the-card-can-post-a-report.test.ts` reads this file too.

export const DeliveredPanel = ({ delivery, onDone }: {
  delivery: api.ReportDelivery;
  onDone: () => void;
}) => (
  <div className="fixed bottom-4 right-4 z-[200] w-[min(30rem,calc(100vw-2rem))] glass-card p-4 space-y-3">
    <h3 className="card-header">Your report is ready to post</h3>
    {delivery.issueUrl ? (
      <div className="space-y-2">
        <p className="text-xs text-ui/80">
          Posted. <a className="text-cp-teal underline" href={delivery.issueUrl} target="_blank" rel="noreferrer">Open the issue</a>
        </p>
        {/* THE REPORT LANDED AND IS NOT QUITE WHAT WAS APPROVED (T8). GitHub needs write access
            to set labels on a new issue and needs none to open one, so an outside reporter's
            labelled request is refused and the bare one succeeds. The sentence is the SERVER's,
            verbatim — it carries GitHub's own words and the evidence for them, and only the
            owner can label the issue now. Rendered as a notice, not an error: nothing failed. */}
        {delivery.labelsDropped && (
          <p className="text-xs text-ui/80 bg-cp-amber/10 border border-cp-amber/25 rounded-lg p-2 whitespace-pre-wrap">
            {delivery.labelsDropped}
          </p>
        )}
      </div>
    ) : (
      <div className="space-y-2">
        <p className="text-xs text-ui/80">Saved on this Mac:</p>
        <p className="text-[11px] text-ui/60 break-all bg-ui/[0.04] rounded p-2">{delivery.exportPath}</p>
        <p className="text-xs text-ui/80">
          {delivery.bodyWasTrimmed
            ? 'It is too long to prefill, so the full text is in the file — open it and paste.'
            : 'The link below opens a new issue with the text already filled in.'}
        </p>
        {delivery.newIssueUrl && (
          <a className="text-xs text-cp-teal underline break-all" href={delivery.newIssueUrl} target="_blank" rel="noreferrer">
            Open a new issue with this text
          </a>
        )}
      </div>
    )}
    <button className="px-3 py-1 text-xs rounded glass-btn-secondary" onClick={onDone}>Done</button>
  </div>
);

/**
 * The duplicate question. NOTHING HAS BEEN POSTED when this is on screen and the owner's
 * approval has been handed back, so every button here is a fresh decision — including Cancel,
 * which leaves the report exactly where it was, still waiting.
 */
export const DuplicatePanel = ({ match, busy, onAdd, onSeparate, onDismiss }: {
  match: DuplicateMatch; busy: boolean;
  onAdd: () => void; onSeparate: () => void; onDismiss: () => void;
}) => (
  <div className="fixed bottom-4 right-4 z-[200] w-[min(30rem,calc(100vw-2rem))] glass-card p-4 space-y-3">
    <h3 className="card-header">This looks like a known problem</h3>
    <p className="text-xs text-ui/80 whitespace-pre-wrap">{duplicateQuestion(match)}</p>
    <a className="text-xs text-cp-teal underline break-all" href={match.url} target="_blank" rel="noreferrer">
      Read it first
    </a>
    <div className="flex items-center gap-2">
      <button className="px-3 py-1 text-xs rounded glass-btn-primary" onClick={onAdd} disabled={busy}>
        Add to it
      </button>
      <button className="px-3 py-1 text-xs rounded glass-btn-secondary" onClick={onSeparate} disabled={busy}>
        Post separately
      </button>
      <button className="px-3 py-1 text-xs rounded-lg glass-btn-destructive ml-auto" onClick={onDismiss} disabled={busy}>
        Not now
      </button>
    </div>
  </div>
);
