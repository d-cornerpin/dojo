// ── Settings → The Update tab. `RollbackSection` travels with it: this tab is its only renderer.

import { useState, useEffect, useRef } from 'react';
import * as api from '../../lib/api';
import { DataBackupNotice } from '../DataBackupNotice';
import { DiskSpaceNotice } from '../DiskSpaceNotice';
import { CanvasMarkdown } from '../CanvasMarkdown';
import { formatDateShort } from '../../lib/dates';
import { useRestartWait } from '../../lib/use-restart-wait';



export const UpdateTab = () => {
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<api.UpdateCheckResult | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<api.UpdateChannel>('stable');
  const [switchingChannel, setSwitchingChannel] = useState(false);
  const [dbBackup, setDbBackup] = useState<api.MigrationBackupOutcome | null>(null);
  const restart = useRestartWait();

  // Every path that writes the release info or the channel takes a ticket first and drops its own
  // answer if a newer request started meanwhile, so a slow old answer cannot undo a newer one.
  const latestCheck = useRef(0);

  const checkUpdates = async () => {
    const mine = ++latestCheck.current;
    setChecking(true);
    setError(null);
    const result = await api.checkForUpdates();
    if (mine !== latestCheck.current) { setChecking(false); return; }
    if (result.ok) {
      setUpdateInfo(result.data);
      if (result.data.channel) setChannel(result.data.channel);
      if (result.data.error) setError(result.data.error);
    } else {
      setError(result.error);
    }
    setChecking(false);
  };

  useEffect(() => {
    checkUpdates();
    // Not a new ticket (that would void the first check above); it just yields to any newer request.
    const startedAt = latestCheck.current;
    api.getUpdateChannel().then(r => { if (r.ok && startedAt === latestCheck.current) setChannel(r.data.channel); });
    api.getDbBackupStatus().then(r => { if (r.ok) setDbBackup(r.data.backup); });
  }, []);

  // Switching the channel only changes which release the updater targets; it never
  // auto-downgrades. The returned check refreshes the panel in one trip.
  const switchChannel = async (next: api.UpdateChannel) => {
    if (next === channel || switchingChannel) return;
    const mine = ++latestCheck.current;
    setSwitchingChannel(true);
    setError(null);
    setUpdateResult(null);
    const r = await api.setUpdateChannel(next);
    if (mine !== latestCheck.current) { setSwitchingChannel(false); return; }
    if (r.ok) {
      setChannel(r.data.channel);
      setUpdateInfo(r.data.check);
      if (r.data.check.error) setError(r.data.check.error);
    } else {
      setError(r.error);
    }
    setSwitchingChannel(false);
  };

  const handleUpdate = async () => {
    if (!confirm('This will download the latest version, update the platform, and restart the server. Continue?')) return;
    setUpdating(true);
    setError(null);
    setUpdateResult(null);
    const result = await api.applyUpdate();
    if (result.ok) {
      setUpdateResult(result.data.message);
      const failure = await restart.follow(result.data.newVersion ?? null, result.data.previousVersion ?? updateInfo?.currentVersion ?? null);
      if (failure) { setError(failure); setUpdateResult(null); setUpdating(false); }
    } else {
      setError(result.error);
      setUpdating(false);
    }
  };

  return (
    <div className="scards">
      <div className="tile space-y-4">
        <div>
          <div className="scard__title">Software Update</div>
          <p className="text-xs text-ui/40 mt-1">
            Check for and install updates from the Agent DOJO repository.
          </p>
        </div>
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-ui/55">Update Channel</span>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={switchingChannel}
              onClick={() => switchChannel('stable')}
              className={`btn btn--sm ${channel === 'stable' ? 'btn--primary' : ''}`}
            >
              Stable
            </button>
            <button
              type="button"
              disabled={switchingChannel}
              onClick={() => switchChannel('preflight')}
              className={`btn btn--sm ${channel === 'preflight' ? 'btn--primary' : ''}`}
            >
              Preflight
            </button>
          </div>
        </div>

        {channel === 'preflight' && (
          <div className="alert-banner alert-warning text-xs">
            Preflight installs bleeding-edge pre-release builds for testing, they may be unstable.
            Switching back to Stable won't downgrade you automatically; it just points future updates at the stable channel.
          </div>
        )}

        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-ui/55">Current Version</span>
          <span className="text-sm text-ui/90 font-mono">{updateInfo?.currentVersion ?? '...'}</span>
        </div>

        {updateInfo?.latestVersion && (
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-ui/55">Latest Version</span>
            <span className="text-sm text-ui/90 font-mono">{updateInfo.latestVersion}</span>
          </div>
        )}

        {updateInfo && !updateInfo.updateAvailable && !updateInfo.error && (
          <div className="alert-banner alert-success text-sm">
            You're up to date.
          </div>
        )}

        {updateInfo?.updateAvailable && (
          <div className="alert-banner alert-warning text-sm">
            Update available: {updateInfo.latestVersion}
            {updateInfo.downloadSize && (
              <span className="text-xs text-cp-amber/60 ml-2">
                ({(updateInfo.downloadSize / 1024).toFixed(0)} KB)
              </span>
            )}
          </div>
        )}

        {updateInfo?.releaseNotes && updateInfo.updateAvailable && (
          <div>
            <span className="text-xs text-ui/40">Release Notes</span>
            <div className="mt-1 text-xs text-ui/55 bg-ui/[0.03] rounded p-2 max-h-60 overflow-y-auto">
              <CanvasMarkdown content={updateInfo.releaseNotes} />
            </div>
          </div>
        )}

        {error && (
          <div className="alert-banner alert-error">
            {error}
          </div>
        )}

        {updateResult && (
          <div className="alert-banner alert-info text-sm">
            {updateResult}
          </div>
        )}

        {/* Pre-flight checks for the update about to run, above the record of the last one. */}
        <DiskSpaceNotice disk={updateInfo?.disk} />
        <DataBackupNotice backup={dbBackup} />

        <div className="srow pt-2">
          <button
            type="button"
            onClick={checkUpdates}
            disabled={checking || updating}
            className="btn btn--sm"
          >
            {checking ? 'Checking...' : 'Check for Updates'}
          </button>

          {updateInfo?.updateAvailable && (
            <button
              type="button"
              onClick={handleUpdate}
              /* Never invite a click the platform is about to refuse with a 507. `measured === false`
                 deliberately does not disable it: a disk we cannot read is not a disk we know is full. */
              disabled={updating || updateInfo?.disk?.ok === false}
              className="btn btn--primary btn--sm"
              title={updateInfo?.disk?.ok === false
                ? 'Not enough free disk space, see the warning above'
                : undefined}
            >
              {updating ? 'Updating...' : 'Update Now'}
            </button>
          )}
        </div>

        {updating && (
          <div className="text-xs text-ui/40">
            Downloading and installing update. The server will restart automatically. This page will reload when the new version is running.
            {restart.status && <div data-testid="restart-status">{restart.status}</div>}
          </div>
        )}
      </div>
      <RollbackSection currentVersion={updateInfo?.currentVersion ?? null} />
    </div>
  );
};

const RollbackSection = ({ currentVersion }: { currentVersion: string | null }) => {
  const [releases, setReleases] = useState<api.ReleaseInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restart = useRestartWait();

  const loadReleases = async () => {
    setLoading(true);
    const r = await api.listReleases();
    if (r.ok) {
      setReleases(r.data.releases);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadReleases();
  }, []);

  const handleRollback = async (tag: string, version: string) => {
    if (!confirm(`Roll back to ${version}? This downloads that version, replaces the current install and restarts the server. It does not change your data: if this update changed it, ${version} cannot use it, and Roll Back in the menu bar is the way back with your data.`)) return;
    setRollingBack(tag);
    setError(null);
    setResult(null);
    const r = await api.rollbackToVersion(tag);
    if (r.ok) {
      setResult(r.data.message);
      const failure = await restart.follow(r.data.newVersion ?? version, r.data.previousVersion ?? currentVersion, 'rollback');
      if (failure) { setError(failure); setResult(null); setRollingBack(null); }
    } else {
      setError(r.error ?? 'Rollback failed');
      setRollingBack(null);
    }
  };

  return (
    <div className="tile space-y-3">
      <div className="scard__title">Previous Releases</div>
      <p className="text-xs text-ui/40">
        Roll back to a previous version if the current release has issues.
      </p>

      {loading && <p className="text-xs text-ui/25">Loading releases...</p>}

      {result && (
        <div className="alert-banner alert-info text-sm">
          {result}
          {restart.status && rollingBack && <div data-testid="restart-status">{restart.status}</div>}
        </div>
      )}
      {error && (
        <div className="alert-banner alert-error">
          {error}
        </div>
      )}

      <div className="space-y-1 max-h-[500px] overflow-y-auto">
        {releases.map(r => (
          <div
            key={r.tag}
            className={`flex items-center justify-between p-2.5 rounded-lg ${
              r.isCurrent
                ? 'bg-cp-amber/10 border border-cp-amber/20'
                : 'glass-nested'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-ui/90">{r.version}</span>
                {r.isCurrent && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-cp-amber/20 text-cp-amber font-medium">
                    current
                  </span>
                )}
              </div>
              <div className="text-[10px] text-ui/40 mt-0.5 truncate">
                {r.name} · {formatDateShort(r.publishedAt)}
              </div>
            </div>

            {!r.isCurrent && r.downloadUrl && (
              <button
                onClick={() => handleRollback(r.tag, r.version)}
                disabled={!!rollingBack}
                className="shrink-0 ml-2 px-3 py-1.5 text-xs bg-ui/[0.05] hover:bg-ui/[0.08] border border-ui/[0.10] text-ui/70 hover:text-ui rounded-lg transition-colors disabled:opacity-30"
              >
                {rollingBack === r.tag ? 'Rolling back...' : 'Rollback'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
