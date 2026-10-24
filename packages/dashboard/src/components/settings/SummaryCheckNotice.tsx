// ── v3.5 (fix round 2): the Summarization Model card says when its writer is failing ──
// Owner 2026-10-20: "If there are significant summarization failures on a dojo, the user is encouraged to
// change the summarization model to another larger model." The server reports, for the CURRENT summary
// writer, how many of its recent summaries failed the accuracy check (`GET /config/summary-check`).
import { useEffect, useState } from 'react';
import * as api from '../../lib/api';

interface Status { writer: string | null; failed: number; total: number; failing: boolean }

export const SummaryCheckNotice = () => {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    void api.request<Status>('/config/summary-check').then((r) => { if (r.ok && r.data && typeof r.data.failing === 'boolean') setStatus(r.data); });
  }, []);
  if (!status?.failing) return null;
  return (
    <div className="alert-banner alert-warning">
      {`This box's memory summaries keep failing the accuracy check (${status.failed} of the last ${status.total}); those parts of the conversation are left as they are. A larger model may do better: pick one here.`}
    </div>
  );
};
