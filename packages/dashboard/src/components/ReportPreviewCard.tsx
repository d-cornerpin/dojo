import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { briefEditsFor, briefIsPostable, postTargetSentence, type BriefFields } from '../lib/report-edits';

// ── THE PREVIEW CARD — THE ONLY DOOR TO POSTING (DOJO-REPORT T6) ──
//
// Owner ruling D4: *"the user sees the exact text before anything posts. No preview, no post."*
// Everything below is that sentence; nothing below is decoration.
//
// ── THE BRIEF IS RENDERED VERBATIM, AND THAT IS A DESIGN DECISION ──
// Each field goes into a `<p className="whitespace-pre-wrap">`, so what the owner reads is the
// string byte for byte. This card deliberately does NOT use `<Markdown>`: a renderer would show
// *emphasis* where the text says `*emphasis*`, and the owner would approve one thing while
// another was published. A clause reads this file and refuses the import.
//
// ── THE DECISIONS ARE NOT IN THIS FILE ──
// `packages/dashboard` has no test runner. The sentence that says where the report goes, the
// only-what-moved edit rule, and the "is this postable" check all live in `lib/report-edits.ts`
// and are driven from the server's suite against the real doors. What is left here is JSX, two
// subscriptions and the busy flags. ⚠ THE CONSENT SENTENCE MUST NOT BE COPIED INTO THIS FILE:
// a second copy is a claim about where an owner's words go that nothing checks, and a census
// refuses the two phrases by name.
//
// ── ONE REPORT AT A TIME, AND THE DELIVERY OUTLIVES THE ROW ──
// A queue of consent decisions is how a gate becomes a habit, so the rest wait their turn. And
// on an unconnected box the answer carries a file path and a prefilled link while the row leaves
// the list the instant it is delivered — so the answer is held until the owner dismisses it,
// otherwise D2's paste-and-post half is written to disk and never shown.

const SECTIONS: ReadonlyArray<readonly [keyof BriefFields, string]> = [
  ['whatHappened', 'What happened'],
  ['whatShouldHaveHappened', 'What should have happened'],
  ['whyItWentWrong', 'Why it went wrong'],
  ['fixIdeas', 'Fix ideas'],
];

const briefOf = (r: api.ReportRow): BriefFields => ({
  title: r.brief?.title ?? '', whatHappened: r.brief?.whatHappened ?? '',
  whatShouldHaveHappened: r.brief?.whatShouldHaveHappened ?? '',
  whyItWentWrong: r.brief?.whyItWentWrong ?? '', fixIdeas: r.brief?.fixIdeas ?? '',
});

export const ReportPreviewCard = () => {
  const [reports, setReports] = useState<api.ReportRow[]>([]);
  const [github, setGithub] = useState<api.GithubStatus | null>(null);
  const [form, setForm] = useState<BriefFields | null>(null);
  const [delivery, setDelivery] = useState<api.ReportDelivery | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { subscribe } = useWebSocket();
  const toast = useToast();
  const loadedRef = useRef(false);

  // REFETCH ON EVENT, never a partial merge: the frame is a PING carrying {id,title} and no
  // brief at all, so the answer to "what is now true" comes from the door that owns it.
  const load = async (): Promise<void> => {
    const [rows, gh] = await Promise.all([api.listOpenReports(), api.getGithubStatus()]);
    if (rows.ok) setReports(rows.data);
    if (gh.ok) setGithub(gh.data);
  };

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load();
  }, []);

  useEffect(() => {
    const unsubs = [
      subscribe('report:pending', () => { void load(); }),
      // A decision made in another tab. The store's one-shot UPDATE is what actually prevents a
      // second delivery; this is what stops the owner being ASKED twice.
      subscribe('report:resolved', () => { void load(); }),
    ];
    return () => { unsubs.forEach(u => u()); };
  }, [subscribe]);

  const report = reports[0] ?? null;

  const handlePost = async (): Promise<void> => {
    if (!report) return;
    setBusy(true);
    setProblem(null);
    const result = await api.approveReport(report.id);
    setBusy(false);
    if (!result.ok) { setProblem(result.error); void load(); return; }
    setDelivery(result.data);
    setForm(null);
    void load();
  };

  const handleSave = async (): Promise<void> => {
    if (!report || !form) return;
    const postable = briefIsPostable(form);
    if (!postable.ok) { setProblem(postable.reason); return; }
    const edits = briefEditsFor(briefOf(report), form);
    // Nothing moved. Saving nothing is not an error, and the door refuses an empty patch.
    if (Object.keys(edits).length === 0) { setForm(null); return; }
    setBusy(true);
    setProblem(null);
    const result = await api.editReportBrief(report.id, edits);
    setBusy(false);
    if (!result.ok) { setProblem(result.error); return; }
    // Back to the preview. SAVING IS NEVER APPROVING — the owner re-reads and presses Post.
    setForm(null);
    void load();
  };

  const handleCancel = async (): Promise<void> => {
    if (!report) return;
    if (!confirmCancel) { setConfirmCancel(true); return; }
    setBusy(true);
    const result = await api.cancelReport(report.id);
    setBusy(false);
    setConfirmCancel(false);
    if (!result.ok) { setProblem(result.error); return; }
    toast.info('Report discarded. Nothing was sent.');
    void load();
  };

  if (delivery) {
    return (
      <div className="fixed bottom-4 right-4 z-[200] w-[min(30rem,calc(100vw-2rem))] glass-card p-4 space-y-3">
        <h3 className="card-header">Your report is ready to post</h3>
        {delivery.issueUrl ? (
          <p className="text-xs text-ui/80">
            Posted. <a className="text-cp-teal underline" href={delivery.issueUrl} target="_blank" rel="noreferrer">Open the issue</a>
          </p>
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
        <button className="px-3 py-1 text-xs rounded glass-btn-secondary" onClick={() => setDelivery(null)}>Done</button>
      </div>
    );
  }

  if (!report || !report.brief) return null;
  const brief = briefOf(report);

  return (
    <div className="fixed bottom-4 right-4 z-[200] w-[min(30rem,calc(100vw-2rem))] max-h-[80vh] overflow-y-auto glass-card p-4 space-y-3">
      <h3 className="card-header">A problem report is waiting for you</h3>

      <p className="text-xs text-ui/80 bg-cp-amber/10 border border-cp-amber/25 rounded-lg p-2">
        {postTargetSentence({
          connected: github?.connected ?? false,
          login: github?.login ?? null,
          loginInProgress: github?.loginInProgress ?? false,
        })}
      </p>

      {problem && <div className="text-xs text-cp-coral">{problem}</div>}

      {form === null ? (
        <div className="space-y-2">
          <p className="text-sm text-ui font-medium whitespace-pre-wrap">{brief.title}</p>
          {SECTIONS.map(([key, heading]) => (
            <div key={key}>
              <p className="section-label">{heading}</p>
              <p className="text-xs text-ui/75 whitespace-pre-wrap">{brief[key]}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <input
            className="glass-input w-full text-sm" value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })}
          />
          {SECTIONS.map(([key, heading]) => (
            <div key={key}>
              <p className="section-label">{heading}</p>
              <textarea
                className="glass-textarea w-full text-xs" rows={4} value={form[key]}
                onChange={e => setForm({ ...form, [key]: e.target.value })}
              />
            </div>
          ))}
        </div>
      )}

      <details className="mt-0.5">
        <summary className="text-[11px] text-ui/40 cursor-pointer hover:text-ui/60 select-none">
          Technical attachment (built by the platform — no conversation content)
        </summary>
        <pre className="mt-1 text-[11px] text-ui/70 whitespace-pre-wrap break-all bg-ui/[0.04] rounded p-2 max-h-64 overflow-y-auto">
          {JSON.stringify(report.telemetry ?? {}, null, 2)}
        </pre>
      </details>

      {form === null ? (
        <div className="flex items-center gap-2">
          <button className="px-3 py-1 text-xs rounded glass-btn-primary" onClick={handlePost} disabled={busy}>
            Post
          </button>
          <button className="px-3 py-1 text-xs rounded glass-btn-secondary" onClick={() => { setProblem(null); setForm(brief); }} disabled={busy}>
            Edit
          </button>
          <button className="px-3 py-1 text-xs rounded-lg glass-btn-destructive ml-auto" onClick={handleCancel} disabled={busy}>
            {confirmCancel ? 'Really discard?' : 'Cancel'}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button className="px-3 py-1 text-xs rounded glass-btn-primary" onClick={handleSave} disabled={busy}>
            Save
          </button>
          <button className="px-3 py-1 text-xs rounded glass-btn-secondary" onClick={() => { setProblem(null); setForm(null); }} disabled={busy}>
            Discard changes
          </button>
        </div>
      )}

      {reports.length > 1 && (
        <p className="text-[11px] text-ui/40">{reports.length - 1} more waiting after this one.</p>
      )}
    </div>
  );
};
