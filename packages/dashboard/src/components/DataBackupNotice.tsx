import * as api from '../lib/api';
import { formatDate } from '../lib/dates';

// Whether the last update that changed the database left a way back: an update can change
// the DATA and reverting the version does NOT undo that, only the snapshot taken just before
// does. Show where it was written; when it was not, say what that costs.
export const DataBackupNotice = ({ backup }: { backup: api.MigrationBackupOutcome | null }) => {
  // Nothing to say: this box has never run an update that changed the database.
  if (!backup || backup.status === 'not-applicable') return null;

  const mb = (n?: number) => (n === undefined ? '?' : `${(n / 1e6).toFixed(0)} MB`);
  const when = formatDate(backup.at);

  if (backup.status === 'written') {
    return (
      <div className="alert-banner alert-success text-sm">
        Your data was backed up before the last update ({when}).
        <div className="text-xs text-ui/55 mt-1 font-mono break-all">{backup.path}</div>
        <div className="text-xs text-ui/55 mt-1">
          {mb(backup.bytes)}. To put your data back to how it was, stop Dojo and run{' '}
          <span className="font-mono">~/.dojo/scripts/restore-db.sh</span>.
        </div>
      </div>
    );
  }

  const why = backup.status === 'skipped-low-disk'
    ? `there was not enough free disk space (it needed ${mb(backup.neededBytes)} free and had ${mb(backup.freeBytes)})`
    : `the backup could not be written (${backup.error ?? 'unknown error'})`;

  return (
    <div className="alert-banner alert-warning text-sm">
      The last update changed your data and <strong>no backup was made first</strong> ({when})
      {backup.overridden ? ', because the backup requirement was overridden' : ''} -{why}.
      <div className="text-xs text-cp-amber/70 mt-1">
        There is no saved copy of your data from before this update, so the previous
        version cannot be put back with it.
      </div>
    </div>
  );
};

