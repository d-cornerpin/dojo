import * as api from '../lib/api';
import { duplicateQuestion, type DuplicateMatch } from '../lib/report-edits';
import { CopyReportButton } from './CopyReportButton';
import { CopyAndOpenButton } from './CopyAndOpenButton';

// What happened to the report: the two panels the owner sees AFTER the decision. They decide
// nothing: no fetch, no state, no rules; the sentences they show come from `lib/report-edits.ts`
// where the server's suite can drive them.
// THE CONSENT SENTENCES MUST NOT BE COPIED INTO THIS FILE. A second copy is a claim about where
// an owner's words go that nothing checks, and the census test reads this file too.

export const DeliveredPanel = ({ delivery, onDone }: {
  delivery: api.ReportDelivery;
  onDone: () => void;
}) => (
  <div className="fixed bottom-4 right-4 z-[200] w-[min(30rem,calc(100vw-2rem))] glass-card p-4 space-y-3">
    <h3 className="card-header">{delivery.issueUrl ? 'Your report is posted' : 'Your report is ready to post'}</h3>
    {delivery.issueUrl ? (
      <div className="space-y-2">
        <p className="text-xs text-ui/80">
          Posted. <a className="text-cp-teal underline" href={delivery.issueUrl} target="_blank" rel="noreferrer">Open the issue</a>
        </p>
        {/* GitHub drops an outside reporter's labels when filing; the server measures which
            survived and writes this sentence, shown here verbatim. A notice, not an error. */}
        {delivery.labelsDropped && (
          <p className="text-xs text-ui/80 bg-cp-amber/10 border border-cp-amber/25 rounded-lg p-2 whitespace-pre-wrap">
            {delivery.labelsDropped}
          </p>
        )}
      </div>
    ) : (
      <div className="space-y-2">
        <p className="text-xs text-ui/80">
          {delivery.bodyWasTrimmed
            ? 'It is too long to fill in by link. One click copies the report and opens GitHub; paste it into the new issue.'
            : 'The link below opens a new issue with your report already filled in. You can also copy the whole report, diagnostics included.'}
        </p>
        {delivery.bodyWasTrimmed && delivery.reportText && delivery.newIssueUrl && (
          <CopyAndOpenButton text={delivery.reportText} url={delivery.newIssueUrl} />
        )}
        {delivery.reportText && <CopyReportButton text={delivery.reportText} />}
        {delivery.newIssueUrl && (
          <a className="text-xs text-cp-teal underline break-all" href={delivery.newIssueUrl} target="_blank" rel="noreferrer">
            {delivery.bodyWasTrimmed ? 'Open GitHub to paste it' : 'Open a new issue with this text'}
          </a>
        )}
      </div>
    )}
    <button className="px-3 py-1 text-xs rounded glass-btn-secondary" onClick={onDone}>Done</button>
  </div>
);

// The duplicate question. Nothing has been posted and the approval was handed back, so every
// button here is a fresh decision, including Cancel, which leaves the report waiting.
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
