// ── Settings → The Update tab. `RollbackSection` travels with it: this tab is its only renderer.
//
// Lifted OUT of `pages/Settings.tsx` by t111-E1. The moved lines are VERBATIM; the only new
// bytes are this header, the imports below and the `export` keyword(s).

import { useState, useEffect } from 'react';
import * as api from '../../lib/api';
import { DataBackupNotice } from '../DataBackupNotice';
import { DiskSpaceNotice } from '../DiskSpaceNotice';
import { formatDateShort } from '../../lib/dates';


// ── Update Tab ──

export const UpdateTab = () => {
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<api.UpdateCheckResult | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<api.UpdateChannel>('stable');
  const [switchingChannel, setSwitchingChannel] = useState(false);
  const [dbBackup, setDbBackup] = useState<api.MigrationBackupOutcome | null>(null);

  const checkUpdates = async () => {
    setChecking(true);
    setError(null);
    const result = await api.checkForUpdates();
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
    api.getUpdateChannel().then(r => { if (r.ok) setChannel(r.data.channel); });
    api.getDbBackupStatus().then(r => { if (r.ok) setDbBackup(r.data.backup); });
  }, []);

  // Switching the channel only changes which release the updater targets — it
  // never auto-downgrades. The returned check refreshes the panel in one trip.
  const switchChannel = async (next: api.UpdateChannel) => {
    if (next === channel || switchingChannel) return;
    setSwitchingChannel(true);
    setError(null);
    setUpdateResult(null);
    const r = await api.setUpdateChannel(next);
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
      setTimeout(() => {
        const poll = setInterval(async () => {
          try {
            const r = await api.getVersion();
            if (r.ok) {
              clearInterval(poll);
              window.location.reload();
            }
          } catch { /* still restarting */ }
        }, 2000);
        setTimeout(() => clearInterval(poll), 60000);
      }, 3000);
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

        {/* Channel selector: Stable (everyone) vs Preflight (pre-release test builds) */}
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
            Preflight installs bleeding-edge pre-release builds for testing — they may be unstable.
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
            <pre className="mt-1 text-xs text-ui/55 whitespace-pre-wrap font-mono bg-ui/[0.03] rounded p-2 max-h-40 overflow-y-auto">
              {updateInfo.releaseNotes}
            </pre>
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

        {/* SWEEP CORE-2 item 3: the pre-flight for the update being CONSIDERED, above the
            record of the last one that HAPPENED. */}
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
              /* The button must not invite a click the platform is about to refuse with a
                 507. `measured === false` deliberately does NOT disable it — a disk we
                 cannot read is not a disk we know is full. */
              disabled={updating || updateInfo?.disk?.ok === false}
              className="btn btn--primary btn--sm"
              title={updateInfo?.disk?.ok === false
                ? 'Not enough free disk space — see the warning above'
                : undefined}
            >
              {updating ? 'Updating...' : 'Update Now'}
            </button>
          )}
        </div>

        {updating && (
          <div className="text-xs text-ui/40">
            Downloading and installing update. The server will restart automatically. This page will reload when the server is back.
          </div>
        )}
      </div>

      {/* Previous releases for rollback */}
      <RollbackSection currentVersion={updateInfo?.currentVersion ?? null} />
    </div>
  );
};

// ── Rollback to Previous Releases ──

const RollbackSection = ({ currentVersion }: { currentVersion: string | null }) => {
  const [releases, setReleases] = useState<api.ReleaseInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (!confirm(`Roll back to ${version}? This will download that version, replace the current install, and restart the server.`)) return;
    setRollingBack(tag);
    setError(null);
    setResult(null);
    const r = await api.rollbackToVersion(tag);
    if (r.ok) {
      setResult(r.data.message);
      setTimeout(() => {
        const poll = setInterval(async () => {
          try {
            const v = await api.getVersion();
            if (v.ok) { clearInterval(poll); window.location.reload(); }
          } catch { /* still restarting */ }
        }, 2000);
        setTimeout(() => clearInterval(poll), 60000);
      }, 3000);
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
