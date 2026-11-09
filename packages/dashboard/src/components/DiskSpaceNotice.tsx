import * as api from '../lib/api';

// The disk-space pre-flight sits immediately above `DataBackupNotice`, and the order is
// deliberate: this one is about the update being considered now, that one a record of the last.

const gb = (n: number | null | undefined): string =>
  n === null || n === undefined ? '?' : `${(n / 1e9).toFixed(2)} GB`;

export const DiskSpaceNotice = ({ disk }: { disk: api.UpdateDiskNeed | null | undefined }) => {
  // Nothing measured, or nothing to warn about: say nothing.
  if (!disk) return null;

  // The volume could not be read. Reported rather than hidden: not knowing is a different
  // thing from being told you are fine. It never blocks.
  if (!disk.measured) {
    return (
      <div className="alert-banner alert-info text-sm">
        Dojo could not read how much free space this disk has, so it cannot check ahead of
        time whether this update will fit. The update will still stop safely if it runs short.
      </div>
    );
  }

  if (disk.ok) return null;

  return (
    <div className="alert-banner alert-warning text-sm">
      <strong>Not enough free disk space for this update.</strong> It needs about{' '}
      {gb(disk.totalNeedBytes)} free while it works and this disk has {gb(disk.freeBytes)}, 
      about <strong>{gb(disk.shortfallBytes)} short</strong>.
      <div className="text-xs text-ui/55 mt-1">
        That is {gb(disk.artifactBytes)} to download, {gb(disk.platformBytes * 2)} to unpack it
        and keep a copy of the version you have now, and {gb(disk.backupNeedBytes)} to back up
        your data (your database is {gb(disk.dbBytes)}).
      </div>
      <div className="text-xs text-cp-amber/70 mt-1">
        Nothing has been downloaded and nothing has changed. Free up some space and check for
        updates again.
      </div>
    </div>
  );
};
