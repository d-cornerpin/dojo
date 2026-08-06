import * as api from '../lib/api';

/**
 * Whether the last update that changed the database left a way back.
 *
 * This is the one fact about an update that nothing in the product used to say. An
 * update can change the DATA, and going back to the previous version does NOT undo
 * that — only the snapshot taken just before the change does. When that snapshot was
 * written, the person should be able to see where it is; when it was not, they should
 * be told, in the same breath, what that costs them.
 */
export const DataBackupNotice = ({ backup }: { backup: api.MigrationBackupOutcome | null }) => {
  // Nothing to say: this box has never run an update that changed the database.
  if (!backup || backup.status === 'not-applicable') return null;

  const mb = (n?: number) => (n === undefined ? '?' : `${(n / 1e6).toFixed(0)} MB`);
  const when = new Date(backup.at).toLocaleString();

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
      {backup.overridden ? ', because the backup requirement was overridden' : ''} — {why}.
      <div className="text-xs text-cp-amber/70 mt-1">
        Going back to the previous version puts the old app back but does not undo the
        change to your data. There is no saved copy to restore from this update.
      </div>
    </div>
  );
};

