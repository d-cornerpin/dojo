import * as api from '../lib/api';

// ════════════════════════════════════════════════════════════════════════════════════════
// THE DISK-SPACE PRE-FLIGHT, ON THE SURFACE THE OWNER ALREADY LOOKS AT.
//
// SWEEP CORE-2 item 3, requirement (4) of the owner's 2026-08-06 ask: the notice reaches him
// where he already looks — the Update tab RESTORE-PATH built. It sits immediately ABOVE
// `DataBackupNotice`, and the ordering is deliberate: this one is about the update he is
// considering NOW; that one is a record of the last update that already happened.
//
// It is silent unless there is something to say. A warning that renders on every visit is
// furniture, and furniture is not read.
// ════════════════════════════════════════════════════════════════════════════════════════

const gb = (n: number | null | undefined): string =>
  n === null || n === undefined ? '?' : `${(n / 1e9).toFixed(2)} GB`;

export const DiskSpaceNotice = ({ disk }: { disk: api.UpdateDiskNeed | null | undefined }) => {
  // Nothing measured, or nothing to warn about: say nothing.
  if (!disk) return null;

  // The volume could not be read. Reported rather than hidden — the platform not knowing is
  // a different thing from the platform saying you are fine — but it never blocks.
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
      {gb(disk.totalNeedBytes)} free while it works and this disk has {gb(disk.freeBytes)} —
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
