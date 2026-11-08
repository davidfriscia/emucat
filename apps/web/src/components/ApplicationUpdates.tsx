import { useCallback, useEffect, useState } from 'react';
import {
  UPDATE_PROGRESS_STAGES,
  type ApplicationUpdatesResponse,
  type UpdateLogResponse,
  type UpdateOperation,
  type UpdateStage,
} from '@emucat/contracts';
import {
  ApiRequestError,
  checkForUpdates,
  fetchApplicationUpdates,
  fetchUpdateLog,
  startApplicationUpdate,
} from '../api';
import { usePolledData } from '../usePolledData';
import { describeError } from './States';

export const STAGE_LABELS: Record<UpdateStage, string> = {
  queued: 'Queued',
  checking_repository: 'Checking repository',
  fetching_source: 'Fetching source',
  building: 'Building',
  testing: 'Testing',
  backing_up_database: 'Backing up database',
  applying_migrations: 'Applying migrations',
  starting_services: 'Starting services',
  health_checking: 'Health checking',
  completed: 'Completed',
  failed: 'Failed',
};

const ROLLBACK_TEXT: Record<NonNullable<UpdateOperation['rollback']>, string> = {
  not_needed: 'Nothing was changed: the previous release is still running.',
  restored_previous: 'The previous release was started again and is running.',
  unsafe:
    'Database migrations may have been applied, so the previous release was not restarted ' +
    'automatically. Check the server with emucatctl status, and restore the backup if needed.',
  failed: 'The previous release could not be restarted. Check the server with emucatctl status.',
};

/** While an update runs, the API itself is replaced; this long without an answer means something is wrong. */
export const RECONNECT_GIVE_UP_MS = 10 * 60 * 1000;
const POLL_ACTIVE_MS = 2_000;
const POLL_IDLE_MS = 15_000;
const WATCH_KEY = 'emucat.update.watching';

function readWatched(): string | null {
  try {
    return localStorage.getItem(WATCH_KEY);
  } catch {
    return null;
  }
}

function writeWatched(id: string | null): void {
  try {
    if (id) localStorage.setItem(WATCH_KEY, id);
    else localStorage.removeItem(WATCH_KEY);
  } catch {
    // Storage can be unavailable; the server still knows the operation.
  }
}

const shortCommit = (commit: string | null | undefined) => (commit ? commit.slice(0, 12) : '—');
const formatTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : '—';

function Commit({ commit }: { commit: string | null | undefined }) {
  return commit ? (
    <code title={commit} data-testid="commit">
      {shortCommit(commit)}
    </code>
  ) : (
    <span>—</span>
  );
}

function isUnreachable(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.status === 0 || error.code === 'unreachable' || error.status >= 502)
  );
}

export function UpdateProgress({ operation }: { operation: UpdateOperation }) {
  const reached = new Set(operation.stages.map((record) => record.stage));
  const failedAt =
    operation.status === 'failed'
      ? operation.stages.filter((record) => record.stage !== 'failed').at(-1)?.stage
      : undefined;
  return (
    <ol className="list-unstyled small mb-0 update-stages" aria-label="Update progress">
      {UPDATE_PROGRESS_STAGES.map((stage) => {
        const current = operation.status === 'running' && operation.stage === stage;
        const failed = stage === failedAt;
        const done = reached.has(stage) && !current && !failed;
        const state = failed ? 'failed' : current ? 'current' : done ? 'done' : 'pending';
        return (
          <li key={stage} data-state={state} className="d-flex align-items-center gap-2">
            <span aria-hidden="true" className="update-stage-icon">
              {failed ? '✕' : current ? '…' : done ? '✓' : '○'}
            </span>
            <span className={state === 'pending' ? 'text-body-secondary' : undefined}>
              {STAGE_LABELS[stage]}
            </span>
            {current ? <span className="visually-hidden">(in progress)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function OperationResult({ operation }: { operation: UpdateOperation }) {
  if (operation.status === 'running') return null;
  if (operation.status === 'succeeded') {
    return (
      <div className="alert alert-success small mb-0" role="status">
        {operation.outcome === 'up_to_date'
          ? 'Already up to date.'
          : `Update completed: ${shortCommit(operation.targetCommit)} is deployed and healthy.`}
      </div>
    );
  }
  return (
    <div className="alert alert-danger small mb-0" role="alert">
      <p className="fw-semibold mb-1">The update failed.</p>
      <p className="mb-1">{operation.error?.message ?? 'No reason was recorded.'}</p>
      {operation.rollback ? <p className="mb-1">{ROLLBACK_TEXT[operation.rollback]}</p> : null}
      {operation.backup ? (
        <p className="mb-0">
          Database backup taken before the change: <code>{operation.backup}</code>
        </p>
      ) : null}
    </div>
  );
}

function ServiceBadge({ service }: { service: ApplicationUpdatesResponse['service'] }) {
  const text = {
    connected: 'Connected',
    unavailable: 'Unavailable',
    not_configured: 'Not configured',
  }[service];
  const tone = { connected: 'success', unavailable: 'danger', not_configured: 'secondary' }[
    service
  ];
  return <span className={`badge text-bg-${tone}`}>{text}</span>;
}

/**
 * Application updates, for administrators. The deployment service on the server owns every operation, so
 * this view can be closed, refreshed or cut off while the application restarts, and picks up the real
 * outcome when the server answers again.
 */
export function ApplicationUpdates() {
  const [watched, setWatched] = useState<string | null>(readWatched);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'check' | 'install' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [log, setLog] = useState<UpdateLogResponse | null>(null);
  const [logError, setLogError] = useState<unknown>(null);
  /** When the server stopped answering, or `null` while it answers. */
  const [lostSince, setLostSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await fetchApplicationUpdates(signal);
      setLostSince(null);
      // An update started elsewhere, or before this page loaded, is followed (and polled) too.
      const running = result.deployment?.activeOperation?.id;
      if (running) setWatched(running);
      return result;
    } catch (failure) {
      if (isUnreachable(failure)) setLostSince((since) => since ?? Date.now());
      throw failure;
    }
  }, []);
  const { data, error, loading, setData } = usePolledData(
    load,
    watched !== null || lostSince !== null ? POLL_ACTIVE_MS : POLL_IDLE_MS,
  );

  const deployment = data?.deployment ?? null;
  const activeOperation = deployment?.activeOperation ?? null;
  const lastOperation = deployment?.lastOperation ?? null;
  const unreachable = error !== null && isUnreachable(error);
  // Follows whichever operation is running, including one started elsewhere or before a refresh, until
  // the administrator dismisses its result.
  const followed = activeOperation?.id ?? (watched !== dismissed ? watched : null);
  const active = followed !== null;

  useEffect(() => {
    writeWatched(followed);
  }, [followed]);

  useEffect(() => {
    if (lostSince === null) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [lostSince]);

  const watchedOperation =
    activeOperation ?? (lastOperation && lastOperation.id === followed ? lastOperation : null);
  const finished = watchedOperation !== null && watchedOperation.status !== 'running';

  const stopWatching = () => {
    setDismissed(followed);
    setWatched(null);
  };

  const check = async () => {
    setBusy('check');
    setActionError(null);
    try {
      setData(await checkForUpdates());
    } catch (failure) {
      setActionError(failure);
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    const commit = deployment?.latest?.commit;
    if (!commit) return;
    setBusy('install');
    setActionError(null);
    try {
      const operation = await startApplicationUpdate(commit);
      setWatched(operation.id);
      setConfirming(false);
      setLog(null);
      if (data && deployment) {
        setData({
          ...data,
          deployment: { ...deployment, activeOperation: operation, lastOperation: operation },
        });
      }
    } catch (failure) {
      setActionError(failure);
      setConfirming(false);
    } finally {
      setBusy(null);
    }
  };

  const showLog = async () => {
    const operation = watchedOperation ?? lastOperation;
    if (!operation) return;
    setLogError(null);
    try {
      setLog(await fetchUpdateLog(operation.id));
    } catch (failure) {
      setLogError(failure);
    }
  };

  const lostFor = lostSince !== null ? Math.max(0, now - lostSince) : 0;
  const connectionNotice =
    unreachable && active ? (
      lostFor >= RECONNECT_GIVE_UP_MS ? (
        <div className="alert alert-danger small" role="alert">
          The server has not answered for over {Math.round(RECONNECT_GIVE_UP_MS / 60000)} minutes
          while an update was running. Its outcome is unknown: do not assume it succeeded. Check the
          server with <code>emucatctl status</code>.
        </div>
      ) : (
        <div className="alert alert-warning small" role="status">
          The application is restarting as part of the update. This page reconnects by itself and
          shows the result.
        </div>
      )
    ) : unreachable ? (
      <div className="alert alert-warning small" role="status">
        The server is not answering. Retrying…
      </div>
    ) : null;

  if (loading && !data) {
    return <p className="small text-body-secondary mb-0">Loading update status…</p>;
  }
  if (!data) {
    // After a refresh during an update, the first answer may be from a server that is restarting.
    return (
      connectionNotice ?? (
        <p className="small text-danger mb-0" role="alert">
          Update status is unavailable: {describeError(error)}
        </p>
      )
    );
  }

  const connected = data.service === 'connected' && deployment !== null;
  const updatesEnabled = deployment?.updatesEnabled ?? false;
  const canInstall =
    connected &&
    updatesEnabled &&
    !activeOperation &&
    deployment.updateAvailable === true &&
    deployment.latest !== null &&
    busy === null;

  return (
    <div className="application-updates">
      {connectionNotice}

      {data.service === 'not_configured' ? (
        <p className="small text-body-secondary">
          Application updates are not configured on this server. They are available on installations
          deployed with <code>emucatctl</code>.
        </p>
      ) : null}
      {data.service === 'unavailable' ? (
        <div className="alert alert-danger small" role="alert">
          The deployment service is not answering. Updates cannot be checked or installed until it
          is running again (<code>systemctl status emucat-deployer</code> on the server).
        </div>
      ) : null}
      {connected && !updatesEnabled ? (
        <div className="alert alert-secondary small" role="status">
          Updates from the browser are disabled on this server. They can only be installed from the
          server’s command line.
        </div>
      ) : null}

      <dl className="mb-3 small settings-facts">
        <dt>Environment</dt>
        <dd>{deployment?.environment ?? '—'}</dd>
        <dt>Branch</dt>
        <dd>{deployment ? <code>{deployment.branch}</code> : '—'}</dd>
        <dt>Deployed commit</dt>
        <dd>
          <Commit commit={deployment?.current?.commit ?? data.build.commit} />
        </dd>
        <dt>Deployed at</dt>
        <dd>{formatTime(deployment?.current?.deployedAt)}</dd>
        <dt>Latest available</dt>
        <dd>
          {deployment?.latest ? (
            <>
              <Commit commit={deployment.latest.commit} />{' '}
              <span className="text-body-secondary">{deployment.latest.subject}</span>
              <div className="text-body-secondary">
                Checked {formatTime(deployment.latest.checkedAt)}
              </div>
            </>
          ) : (
            'Not checked yet'
          )}
        </dd>
        <dt>Update</dt>
        <dd data-testid="update-availability">
          {deployment?.updateAvailable === true
            ? 'Available'
            : deployment?.updateAvailable === false
              ? 'Up to date'
              : 'Unknown'}
        </dd>
        <dt>Current operation</dt>
        <dd>
          {activeOperation
            ? `${STAGE_LABELS[activeOperation.stage]} (started by ${activeOperation.requestedBy})`
            : 'None'}
        </dd>
        <dt>Last successful update</dt>
        <dd>
          {deployment?.lastSuccess ? (
            <>
              <Commit commit={deployment.lastSuccess.commit} />,{' '}
              {formatTime(deployment.lastSuccess.finishedAt)}
            </>
          ) : (
            '—'
          )}
        </dd>
        <dt>Last failed update</dt>
        <dd>
          {deployment?.lastFailure ? (
            <>
              <Commit commit={deployment.lastFailure.commit} />,{' '}
              {formatTime(deployment.lastFailure.finishedAt)}
            </>
          ) : (
            '—'
          )}
        </dd>
        <dt>Deployment service</dt>
        <dd>
          <ServiceBadge service={data.service} />
        </dd>
      </dl>

      {actionError ? (
        <div className="alert alert-danger small" role="alert">
          {describeError(actionError)}
        </div>
      ) : null}

      {watchedOperation ? (
        <section className="mb-3" aria-label="Update in progress">
          <UpdateProgress operation={watchedOperation} />
          {finished ? (
            <div className="mt-2">
              <OperationResult operation={watchedOperation} />
              <button
                type="button"
                className="btn btn-sm btn-link px-0"
                onClick={() => stopWatching()}
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {confirming ? (
        <div className="border rounded p-3 mb-3" role="dialog" aria-label="Confirm update">
          <p className="small mb-2">
            Install <Commit commit={deployment?.latest?.commit} /> from{' '}
            <code>{deployment?.branch}</code> on <strong>{deployment?.environment}</strong>? The
            database is backed up first. The application may be unavailable for a few minutes while
            it restarts, and connected agents reconnect afterwards.
          </p>
          <div className="d-flex gap-2">
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void install()}
              disabled={busy !== null}
            >
              {busy === 'install' ? 'Starting…' : 'Install now'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          onClick={() => void check()}
          disabled={!connected || busy !== null || activeOperation !== null}
        >
          {busy === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setConfirming(true)}
          disabled={!canInstall || confirming}
        >
          Install update
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => void showLog()}
          disabled={!connected || !(watchedOperation ?? lastOperation)}
        >
          View update log
        </button>
      </div>

      {logError ? (
        <p className="small text-danger mt-2 mb-0" role="alert">
          {describeError(logError)}
        </p>
      ) : null}
      {log ? (
        <pre className="update-log small border rounded p-2 mt-3 mb-0" aria-label="Update log">
          {log.truncated ? '… earlier lines omitted …\n' : ''}
          {log.lines.join('\n') || 'The log is empty.'}
        </pre>
      ) : null}
    </div>
  );
}
