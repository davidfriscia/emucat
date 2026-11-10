import {
  EMULATOR_LABELS,
  isSessionActive,
  isWorkspaceActive,
  remoteSessionStep,
  type ExecutionAgentOption,
  type ExecutionMode,
  type ExecutionOptionsResponse,
  type LaunchIneligibleReason,
  type RemoteIneligibleReason,
  type RemoteSession,
  type RemoteSessionMode,
  type RemoteSessionStep,
  type VerifyIneligibleReason,
  type VmIdentity,
  type VmSession,
  type VmSessionState,
  type VmVerification,
  type WorkspacePurpose,
  type WorkspaceState,
} from '@emucat/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createWorkspace,
  discardWorkspace,
  dismissSession,
  fetchExecutionOptions,
  fetchRestoreOptions,
  fetchVmSessions,
  fetchWorkspaces,
  launchVm,
  resumeWorkspace,
  retryPublication,
  stopSession,
  verifyLocalCopy,
} from '../api';
import { usePolledData } from '../usePolledData';
import { formatBytes, formatTime } from './Agents';
import { ConfirmByName } from './Dialogs';
import { useModalDialog } from './Gallery';
import { restoreStateText, versionNamer, type VersionNamer } from './Restore';
import { shortId, SNAPSHOT_STATE_TEXT, versionLabel } from './Snapshots';
import { FormError } from './States';

const ACTIVE_POLL_MS = 1_500;
const IDLE_POLL_MS = 10_000;

export const SESSION_STATE_TEXT: Record<VmSessionState, string> = {
  requested: 'Requested',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  exited: 'Exited',
  failed: 'Failed',
  interrupted: 'Interrupted',
  unknown: 'State unknown',
};

export const MODE_TEXT: Record<ExecutionMode, string> = {
  local: 'Local',
  remote_volatile: 'Remote Volatile',
  remote_snapshot: 'Remote Snapshot',
};

const MODE_EXPLANATION: Record<ExecutionMode, string> = {
  local:
    'Runs the agent’s persistent local copy. Changes stay in that copy, and no version is ever touched.',
  remote_volatile:
    'Obtains the version you choose from the repository into a temporary copy, verified like any restore, and runs it. When the emulator exits, the temporary copy is deleted with every change. No local copy is needed, and the persistent one is not touched.',
  remote_snapshot:
    'Like Remote Volatile, but when the emulator exits the temporary copy is published as a new, immutable snapshot whose parent is exactly the version you chose, and only then deleted. If publishing fails, the copy is kept until it is published or you abandon it.',
};

export const WORKSPACE_STATE_TEXT: Record<WorkspaceState, string> = {
  preparing: 'Preparing',
  ready: 'Ready',
  running: 'Running',
  held: 'Waiting for confirmation',
  publishing: 'Publishing',
  publish_failed: 'Publication failed',
  discarding: 'Cleaning up',
  discarded: 'Finished',
  failed: 'Failed',
  lost: 'Lost',
};

const LAUNCH_TEXT: Record<LaunchIneligibleReason, string> = {
  agent_revoked: 'revoked',
  agent_offline: 'offline',
  agent_cannot_launch: 'its version cannot launch VMs',
  emulator_not_launchable: 'it cannot launch this emulator',
  vm_not_on_agent: 'it holds no copy of this VM',
  session_active: 'the VM is already running there',
  operation_in_progress: 'busy with this VM',
};

const REMOTE_TEXT: Record<RemoteIneligibleReason, string> = {
  agent_revoked: 'revoked',
  agent_offline: 'offline',
  agent_cannot_launch: 'its version cannot launch VMs',
  emulator_not_launchable: 'it cannot launch this emulator',
  mode_not_supported: 'its version cannot run this mode',
  agent_cannot_restore: 'its version cannot obtain VMs from a repository',
  emulator_not_configured: 'no base path for this emulator',
  repository_not_authorized: 'not associated with this VM’s repository',
  repository_not_configured: 'no local settings for this repository',
  no_versions: 'this VM has no version to run',
  session_active: 'the VM is already running there',
  remote_session_pending: 'a remote session of this VM is still pending there',
  operation_in_progress: 'busy with this VM',
};

const VERIFY_TEXT: Record<VerifyIneligibleReason, string> = {
  agent_revoked: 'revoked',
  agent_offline: 'offline',
  agent_cannot_verify: 'its version cannot verify VMs',
  no_master: 'there is no master to compare with',
  vm_not_on_agent: 'it holds no copy of this VM',
  session_active: 'the VM is running there',
  operation_in_progress: 'busy with another operation',
};

const VERIFY_STATUS_TEXT: Record<NonNullable<VmVerification['status']>, string> = {
  verified: 'Verified: identical to its version',
  modified: 'Modified: differs from its version',
  missing: 'Missing files',
  unavailable: 'Could not be checked',
  verification_failed: 'Verification failed',
};

const MANIFEST_SOURCE_TEXT: Record<NonNullable<VmVerification['manifestSource']>, string> = {
  local: 'kept with the local copy',
  cache: 'from the archive in the agent’s cache',
  repository: 'from the archive in the repository',
};

function sessionBadge(state: VmSessionState): string {
  switch (state) {
    case 'running':
      return 'text-bg-success';
    case 'failed':
      return 'text-bg-danger';
    case 'unknown':
    case 'interrupted':
      return 'text-bg-warning';
    case 'stopped':
    case 'exited':
      return 'text-bg-secondary';
    default:
      return 'text-bg-primary';
  }
}

function workspaceBadge(state: WorkspaceState): string {
  switch (state) {
    case 'running':
      return 'text-bg-success';
    case 'held':
    case 'publish_failed':
    case 'lost':
      return 'text-bg-warning';
    case 'failed':
      return 'text-bg-danger';
    case 'discarded':
      return 'text-bg-secondary';
    default:
      return 'text-bg-primary';
  }
}

function verifyBadge(status: VmVerification['status']): string {
  switch (status) {
    case 'verified':
      return 'text-bg-success';
    case 'modified':
    case 'missing':
      return 'text-bg-warning';
    case null:
      return 'text-bg-primary';
    default:
      return 'text-bg-danger';
  }
}

function contentText(local: ExecutionAgentOption['local']): string {
  if (!local.present) return 'No local copy';
  switch (local.contentStatus) {
    case 'verified':
      return `Local copy verified ${formatTime(local.lastVerifiedAt)}`;
    case 'modified':
      return 'Local copy differs from its version';
    default:
      return 'Local copy, not verified';
  }
}

/** One session: what it is doing, and the controls that make sense for it now. */
export function SessionCard({ session, onChange }: { session: VmSession; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState<'force' | 'dismiss' | null>(null);
  const active = isSessionActive(session.state);
  const canStop =
    active &&
    session.agentOnline &&
    (session.state === 'starting' || session.state === 'running' || session.state === 'stopping');

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await stopSession(session.id, { force: false });
      onChange();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card mb-2" aria-label={`Session of ${session.vmName}`}>
      <div className="card-body">
        <div className="d-flex flex-wrap gap-1 mb-2">
          <span className={`badge ${sessionBadge(session.state)}`}>
            {SESSION_STATE_TEXT[session.state]}
          </span>
          <span className="badge text-bg-dark border">{MODE_TEXT[session.mode]}</span>
          <span className="badge text-bg-dark border">{session.agentName}</span>
          {session.stopRequested && active ? (
            <span className="badge text-bg-light border">
              {session.forceRequested ? 'Forced stop requested' : 'Stop requested'}
            </span>
          ) : null}
        </div>
        <dl className="small settings-facts mb-2">
          {session.pid !== null ? (
            <>
              <dt>Process</dt>
              <dd>
                PID {session.pid}
                {session.processStartedAt
                  ? `, created ${formatTime(session.processStartedAt)}`
                  : ''}
              </dd>
            </>
          ) : null}
          <dt>Requested</dt>
          <dd>
            {formatTime(session.requestedAt)}
            {session.requestedByDisplayName ? ` by ${session.requestedByDisplayName}` : ''}
          </dd>
          {session.startedAt ? (
            <>
              <dt>Started</dt>
              <dd>{formatTime(session.startedAt)}</dd>
            </>
          ) : null}
          {session.endedAt ? (
            <>
              <dt>Ended</dt>
              <dd>
                {formatTime(session.endedAt)}
                {session.exitCode !== null ? `, exit code ${session.exitCode}` : ''}
              </dd>
            </>
          ) : null}
        </dl>
        {active && !session.agentOnline ? (
          <div className="alert alert-warning small mb-2" role="status">
            The agent is offline. The VM is treated as running, and protected, until the agent says
            otherwise.
          </div>
        ) : null}
        {session.error ? (
          <div
            className={`alert small mb-2 ${session.state === 'failed' ? 'alert-danger' : 'alert-warning'}`}
            role="alert"
          >
            {session.error.message}
            {session.recovery ? <div className="mt-1">{session.recovery}</div> : null}
          </div>
        ) : null}
        <FormError error={error} />
        {active ? (
          <div className="d-flex flex-wrap gap-2">
            {canStop ? (
              <button
                type="button"
                className="btn btn-sm btn-outline-primary"
                disabled={busy || !session.gracefulStopAvailable}
                title={
                  session.gracefulStopAvailable
                    ? 'Asks the emulator to close'
                    : 'The emulator cannot be asked to close now'
                }
                onClick={() => void stop()}
              >
                Stop
              </button>
            ) : null}
            {canStop ? (
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                disabled={busy}
                onClick={() => setConfirming('force')}
              >
                Force stop…
              </button>
            ) : null}
            {session.state === 'unknown' || session.state === 'requested' ? (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary theme-button"
                disabled={busy}
                onClick={() => setConfirming('dismiss')}
              >
                Dismiss…
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {confirming === 'force' ? (
        <ConfirmByName
          title={`Force ${session.vmName} to stop`}
          vmName={session.vmName}
          explanation="This ends the emulator at once, like pulling the plug. Anything the guest has not written to disk is lost, and its file systems may need checking. The VM's files are never deleted."
          action="Force stop"
          cancelLabel="Keep it running"
          onClose={() => setConfirming(null)}
          onConfirm={async (typed) => {
            await stopSession(session.id, { force: true, confirmVmName: typed });
            setConfirming(null);
            onChange();
          }}
        />
      ) : null}
      {confirming === 'dismiss' ? (
        <ConfirmByName
          title={`Dismiss this session of ${session.vmName}`}
          vmName={session.vmName}
          explanation="The agent cannot tell whether this emulator runs. Check that computer first: once dismissed, restores, removals and verifications of this VM are allowed again, even if it is still running."
          action="Dismiss"
          cancelLabel="Keep it running"
          onClose={() => setConfirming(null)}
          onConfirm={async (typed) => {
            await dismissSession(session.id, typed);
            setConfirming(null);
            onChange();
          }}
        />
      ) : null}
    </article>
  );
}

function PathList({ label, list }: { label: string; list: VmVerification['missing'] }) {
  if (!list || list.count === 0) return null;
  return (
    <div className="small mb-1">
      {label}: {list.count}
      <ul className="mb-0">
        {list.paths.map((path) => (
          <li key={path} className="vm-identity">
            {path}
          </li>
        ))}
        {list.count > list.paths.length ? <li>and {list.count - list.paths.length} more</li> : null}
      </ul>
    </div>
  );
}

export function VerificationResult({ verification }: { verification: VmVerification }) {
  const pending = verification.state === 'requested';
  return (
    <div className="mb-2" aria-label="Last verification">
      <div className="d-flex flex-wrap gap-1 mb-1">
        <span className={`badge ${verifyBadge(pending ? null : verification.status)}`}>
          {pending
            ? 'Verifying…'
            : verification.state === 'expired'
              ? 'Not answered'
              : verification.status
                ? VERIFY_STATUS_TEXT[verification.status]
                : 'Unknown'}
        </span>
        <span className="small text-body-secondary">
          {formatTime(verification.completedAt ?? verification.requestedAt)}
        </span>
      </div>
      {verification.filesVerified !== null && verification.bytesHashed !== null ? (
        <p className="small mb-1">
          {verification.filesVerified} files and {formatBytes(verification.bytesHashed)} hashed with
          SHA-256
          {verification.durationMs !== null
            ? ` in ${(verification.durationMs / 1000).toFixed(1)} s`
            : ''}
          {verification.manifestSource
            ? `, against the manifest ${MANIFEST_SOURCE_TEXT[verification.manifestSource]}`
            : ''}
          . Screenshots are not part of the check.
        </p>
      ) : null}
      <PathList label="Modified" list={verification.modified} />
      <PathList label="Missing" list={verification.missing} />
      <PathList label="Not in the master" list={verification.unexpected} />
      {verification.error ? (
        <div className="alert alert-warning small mb-0" role="alert">
          {verification.error.message}
          {verification.recovery ? <div className="mt-1">{verification.recovery}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

const STEP_TEXT: Record<RemoteSessionStep, string> = {
  prepare: 'Obtain and verify the version',
  run: 'Run the emulator',
  publish: 'Publish the snapshot',
  cleanup: 'Remove the temporary copy',
};

/** The steps of a remote session, each marked done, current, failed or still to come. */
function RemoteSessionSteps({ workspace }: { workspace: RemoteSession }) {
  const purpose = workspace.purpose as RemoteSessionMode;
  const steps: RemoteSessionStep[] =
    purpose === 'remote_snapshot'
      ? ['prepare', 'run', 'publish', 'cleanup']
      : ['prepare', 'run', 'cleanup'];
  const at = remoteSessionStep(purpose, workspace.state);
  const failedStep: RemoteSessionStep | null =
    workspace.state === 'failed'
      ? 'prepare'
      : workspace.state === 'publish_failed'
        ? 'publish'
        : null;
  const index = at === 'done' ? steps.length : steps.indexOf(at);
  return (
    <ol className="list-unstyled small mb-2 update-stages" aria-label="Steps of this session">
      {steps.map((step, position) => {
        const failed = step === failedStep;
        const unknown = workspace.state === 'lost';
        const current = !failed && !unknown && position === index;
        const done =
          !failed && !unknown && (position < index || workspace.state === 'discarded') && !current;
        const state = failed ? 'failed' : current ? 'current' : done ? 'done' : 'pending';
        return (
          <li
            key={step}
            data-state={state}
            className="d-flex align-items-center gap-2"
            aria-current={current ? 'step' : undefined}
          >
            <span aria-hidden="true" className="update-stage-icon">
              {failed ? '✕' : current ? '…' : done ? '✓' : '○'}
            </span>
            <span className={state === 'pending' ? 'text-body-secondary' : undefined}>
              {STEP_TEXT[step]}
            </span>
            {current ? <span className="visually-hidden">(in progress)</span> : null}
            {failed ? <span className="visually-hidden">(failed)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function remoteOutcome(workspace: RemoteSession, nameVersion: VersionNamer): string {
  switch (workspace.state) {
    case 'discarded':
      if (workspace.snapshotVersionId)
        return `Published as ${nameVersion(workspace.snapshotVersionId)}`;
      if (workspace.abandonedAt) return 'Snapshot abandoned';
      return workspace.purpose === 'remote_volatile'
        ? 'Ended, temporary copy removed'
        : 'Ended without a snapshot, temporary copy removed';
    case 'failed':
      return 'Could not be prepared';
    case 'lost':
      return 'Lost';
    default:
      return WORKSPACE_STATE_TEXT[workspace.state];
  }
}

/**
 * One remote session, from the request to the cleanup: where it is, what the server will do next by
 * itself, and the few decisions that are an administrator's (resume, retry, abandon).
 */
export function RemoteSessionCard({
  workspace,
  nameVersion,
  onChange,
}: {
  workspace: RemoteSession;
  nameVersion: VersionNamer;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState<'resume' | 'abandon' | 'discard' | null>(null);
  const purpose = workspace.purpose as RemoteSessionMode;
  const snapshot = purpose === 'remote_snapshot';
  const base = nameVersion(workspace.baseVersionId);
  const restore = workspace.restore;
  const publication = workspace.snapshot;

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await retryPublication(workspace.id);
      onChange();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className="card mb-2"
      aria-label={`${MODE_TEXT[purpose]} session on ${workspace.agentName}`}
    >
      <div className="card-body">
        <div className="d-flex flex-wrap align-items-center gap-1 mb-2">
          <span className={`badge ${workspaceBadge(workspace.state)}`}>
            {WORKSPACE_STATE_TEXT[workspace.state]}
          </span>
          <span className="badge text-bg-dark border">{MODE_TEXT[purpose]}</span>
          <span className="badge text-bg-dark border">{workspace.agentName}</span>
          {!workspace.agentOnline && isWorkspaceActive(workspace.state) ? (
            <span className="badge text-bg-light border">Agent offline</span>
          ) : null}
        </div>
        <p className="small mb-2">
          Runs <strong>{base}</strong>{' '}
          <span className="vm-identity" title={workspace.baseVersionId}>
            ({shortId(workspace.baseVersionId)})
          </span>
          , from a temporary copy. Requested {formatTime(workspace.createdAt)}
          {workspace.requestedByDisplayName ? ` by ${workspace.requestedByDisplayName}` : ''}.{' '}
          {snapshot
            ? `When it ends, it becomes a new snapshot whose parent is ${base}.`
            : 'When it ends, every change is discarded.'}
        </p>
        <RemoteSessionSteps workspace={workspace} />
        {workspace.state === 'preparing' && restore ? (
          <p className="small mb-2" role="status">
            {restoreStateText(restore.state)}
            {restore.progress.doneBytes !== null && restore.progress.totalBytes
              ? `: ${formatBytes(restore.progress.doneBytes)} of ${formatBytes(restore.progress.totalBytes)}`
              : ''}
            {restore.cache.hit === true ? ', from the agent’s cache' : ''}
          </p>
        ) : null}
        {workspace.session && isSessionActive(workspace.session.state) ? (
          <SessionCard session={workspace.session} onChange={onChange} />
        ) : null}
        {workspace.state === 'publishing' ? (
          <p className="small mb-2" role="status">
            {publication
              ? (SNAPSHOT_STATE_TEXT[publication.state] ?? publication.state)
              : 'Starting the publication'}
            {publication &&
            publication.progress.doneBytes !== null &&
            publication.progress.totalBytes
              ? ` (${Math.round((100 * publication.progress.doneBytes) / publication.progress.totalBytes)}%)`
              : ''}
            {workspace.publishAttempts > 1 ? `, attempt ${workspace.publishAttempts}` : ''}
          </p>
        ) : null}
        {workspace.snapshotVersionId ? (
          <div className="alert alert-success small mb-2" role="status">
            Published as a new immutable version,{' '}
            <span className="vm-identity">{nameVersion(workspace.snapshotVersionId)}</span>, a child
            of {base}.
          </div>
        ) : null}
        {workspace.abandonedAt ? (
          <p className="small text-body-secondary mb-2">
            The snapshot was abandoned {formatTime(workspace.abandonedAt)}: its changes were not
            published.
          </p>
        ) : null}
        {workspace.error && workspace.state !== 'discarded' ? (
          <div
            className={`alert small mb-2 ${workspace.state === 'failed' ? 'alert-danger' : 'alert-warning'}`}
            role="alert"
          >
            {workspace.error.message}
          </div>
        ) : null}
        {workspace.recovery ? <p className="small mb-2">{workspace.recovery}</p> : null}
        {workspace.nextRetryAt && isWorkspaceActive(workspace.state) ? (
          <p className="small text-body-secondary mb-2">
            {workspace.state === 'discarding'
              ? `The agent is asked again ${formatTime(workspace.nextRetryAt)}.`
              : `Retried automatically ${formatTime(workspace.nextRetryAt)}.`}
          </p>
        ) : null}
        <FormError error={error} />
        <div className="d-flex flex-wrap gap-2">
          {workspace.state === 'publish_failed' ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={() => void retry()}
              >
                {busy ? 'Retrying…' : 'Retry publication'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                disabled={busy}
                onClick={() => setConfirming('abandon')}
              >
                Abandon snapshot…
              </button>
            </>
          ) : null}
          {workspace.state === 'held' ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              onClick={() => setConfirming('resume')}
            >
              Resume…
            </button>
          ) : null}
          {workspace.state === 'held' && !snapshot ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              onClick={() => setConfirming('discard')}
            >
              Discard…
            </button>
          ) : null}
        </div>
      </div>
      {confirming === 'resume' ? (
        <ConfirmByName
          title={`Resume this session of ${workspace.vmName}`}
          vmName={workspace.vmName}
          explanation={
            snapshot
              ? 'The agent cannot say whether the emulator still runs. Check that computer first: once resumed, the temporary copy is published as a snapshot, then removed. Publishing a copy the emulator still writes to can capture it half-written.'
              : 'The agent cannot say whether the emulator still runs. Check that computer first: once resumed, the temporary copy is removed.'
          }
          action="Resume"
          onClose={() => setConfirming(null)}
          onConfirm={async (typed) => {
            await resumeWorkspace(workspace.id, typed);
            setConfirming(null);
            onChange();
          }}
        />
      ) : null}
      {confirming === 'abandon' || confirming === 'discard' ? (
        <ConfirmByName
          title={
            confirming === 'abandon'
              ? `Abandon the snapshot of ${workspace.vmName}`
              : `Discard this session of ${workspace.vmName}`
          }
          vmName={workspace.vmName}
          explanation={
            confirming === 'abandon'
              ? 'The temporary copy is deleted without being published. Everything this session changed is lost for good. No existing version is affected.'
              : 'The temporary copy is deleted. Check first that the emulator no longer runs on that computer.'
          }
          action={confirming === 'abandon' ? 'Abandon snapshot' : 'Discard'}
          onClose={() => setConfirming(null)}
          onConfirm={async (typed) => {
            await discardWorkspace(workspace.id, typed);
            setConfirming(null);
            onChange();
          }}
        />
      ) : null}
    </article>
  );
}

function ModeSelector({
  modes,
  value,
  onChange,
}: {
  modes: ExecutionOptionsResponse['modes'];
  value: ExecutionMode;
  onChange: (mode: ExecutionMode) => void;
}) {
  return (
    <fieldset className="mb-3">
      <legend className="form-label fs-6">Execution mode</legend>
      {modes.map((mode) => (
        <div className="form-check" key={mode.mode}>
          <input
            id={`mode-${mode.mode}`}
            className="form-check-input"
            type="radio"
            name="execution-mode"
            value={mode.mode}
            checked={value === mode.mode}
            disabled={!mode.available}
            onChange={() => onChange(mode.mode)}
            aria-describedby={`mode-${mode.mode}-help`}
          />
          <label className="form-check-label" htmlFor={`mode-${mode.mode}`}>
            {MODE_TEXT[mode.mode]}
            {mode.available ? '' : ' (not available)'}
          </label>
          <div id={`mode-${mode.mode}-help`} className="form-text mt-0">
            {mode.available ? MODE_EXPLANATION[mode.mode] : mode.reason}
          </div>
        </div>
      ))}
    </fieldset>
  );
}

/** A version and mode chosen elsewhere, such as in the version history. A new token applies it again. */
export interface RunPreselection {
  versionId: string;
  mode: ExecutionMode;
  token: number;
}

function eligibility(
  agent: ExecutionAgentOption,
  mode: ExecutionMode,
): { eligible: boolean; text: string | null; problem: string | null } {
  if (mode === 'local') {
    return {
      eligible: agent.launch.eligible,
      text: agent.launch.reason ? LAUNCH_TEXT[agent.launch.reason] : null,
      problem: agent.launch.problem,
    };
  }
  const remote = agent.remote[mode];
  return {
    eligible: remote.eligible,
    text: remote.reason ? REMOTE_TEXT[remote.reason] : null,
    problem: remote.problem,
  };
}

/**
 * Running this VM, in any mode, and verifying its local copy: one panel. Local runs the agent's persistent
 * copy; the remote modes run a temporary copy of a version chosen here, which the server prepares, runs
 * and cleans up (and, for Remote Snapshot, publishes) on its own. Administrators only.
 */
export function VmExecutionSection({
  vm,
  preselect = null,
}: {
  vm: VmIdentity;
  preselect?: RunPreselection | null;
}) {
  const { emulatorType, vmName } = vm;
  const loadOptions = useCallback(
    (signal: AbortSignal) => fetchExecutionOptions({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const loadSessions = useCallback(
    (signal: AbortSignal) => fetchVmSessions({ emulatorType, vmName, limit: 10 }, signal),
    [emulatorType, vmName],
  );
  const loadWorkspaces = useCallback(
    (signal: AbortSignal) => fetchWorkspaces({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const loadVersions = useCallback(
    (signal: AbortSignal) => fetchRestoreOptions({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const [fastPoll, setFastPoll] = useState(false);
  const interval = fastPoll ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  const options = usePolledData(loadOptions, interval);
  const sessions = usePolledData(loadSessions, interval);
  const workspaces = usePolledData(loadWorkspaces, interval);
  const versions = usePolledData(loadVersions, IDLE_POLL_MS);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [mode, setMode] = useState<ExecutionMode>(preselect?.mode ?? 'local');
  const [versionId, setVersionId] = useState<string | null>(preselect?.versionId ?? null);
  const [applied, setApplied] = useState<number | null>(preselect?.token ?? null);
  const [busy, setBusy] = useState<'launch' | 'verify' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [started, setStarted] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // One request per intent: a retry after a lost response finds what it already started, and a
  // different agent, version or mode is a different request.
  const request = useRef<{ intent: string; id: string } | null>(null);

  if (preselect && preselect.token !== applied) {
    setApplied(preselect.token);
    setMode(preselect.mode);
    setVersionId(preselect.versionId);
    setError(null);
  }

  const token = preselect?.token;
  useEffect(() => {
    if (token === undefined) return;
    heading.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    heading.current?.focus();
  }, [token]);

  const agents = options.data?.agents ?? [];
  const chosen =
    agents.find((agent) => agent.agentId === agentId) ??
    agents.find((agent) => eligibility(agent, mode).eligible) ??
    agents.find((agent) => agent.activeSession) ??
    agents[0];
  const history = sessions.data?.sessions ?? [];
  const sessionList = workspaces.data?.workspaces ?? [];
  const remoteSessions = sessionList.filter((item) => item.purpose !== 'manual');
  const activeRemote = remoteSessions.filter((item) => isWorkspaceActive(item.state));
  const endedRemote = remoteSessions.filter((item) => !isWorkspaceActive(item.state)).slice(0, 5);
  const purposeOf = new Map<string, WorkspacePurpose>(
    sessionList.map((item) => [item.id, item.purpose]),
  );
  const nameVersion = versionNamer(versions.data);
  const versionChoices =
    versions.data?.versions && versions.data.versions.length > 0
      ? versions.data.versions
      : versions.data?.master
        ? [{ ...versions.data.master, kind: 'master' as const, snapshotName: null }]
        : [];
  // A version chosen elsewhere is never quietly replaced by another one.
  const selectedVersion =
    versionId !== null
      ? versionChoices.find((item) => item.versionId === versionId)
      : (versionChoices.find((item) => item.kind === 'master') ?? versionChoices[0]);

  const transitional =
    history.some((session) => ['requested', 'starting', 'stopping'].includes(session.state)) ||
    agents.some((agent) => agent.lastVerification?.state === 'requested') ||
    activeRemote.some((item) =>
      ['preparing', 'ready', 'publishing', 'discarding'].includes(item.state),
    );
  if (transitional !== fastPoll) setFastPoll(transitional);

  const refresh = () => {
    options.refresh();
    sessions.refresh();
    workspaces.refresh();
  };

  const requestIdFor = (intent: string): string => {
    if (request.current?.intent !== intent) request.current = { intent, id: crypto.randomUUID() };
    return request.current.id;
  };

  const act = async (kind: 'launch' | 'verify') => {
    if (!chosen) return;
    setBusy(kind);
    setError(null);
    setStarted(null);
    try {
      if (kind === 'verify') {
        await verifyLocalCopy({ agentId: chosen.agentId, emulatorType, vmName });
      } else if (mode === 'local') {
        await launchVm({
          agentId: chosen.agentId,
          emulatorType,
          vmName,
          mode,
          requestId: requestIdFor(`local/${chosen.agentId}`),
        });
        request.current = null;
      } else if (selectedVersion) {
        const created = await createWorkspace(vm, {
          agentId: chosen.agentId,
          versionId: selectedVersion.versionId,
          mode,
          requestId: requestIdFor(`${mode}/${chosen.agentId}/${selectedVersion.versionId}`),
        });
        request.current = null;
        setStarted(
          `${MODE_TEXT[mode]} session of ${versionLabel(selectedVersion)} requested on ${created.agentName}.`,
        );
      }
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(null);
    }
  };

  const modeAvailable = options.data?.modes.find((item) => item.mode === mode)?.available ?? false;
  const remote = mode !== 'local';
  const allowed = chosen ? eligibility(chosen, mode) : null;
  const canStart =
    busy === null &&
    modeAvailable &&
    (allowed?.eligible ?? false) &&
    (!remote || (selectedVersion !== undefined && selectedVersion.repositoryEnabled));
  const localSession =
    chosen?.activeSession && !chosen.activeSession.workspaceId ? chosen.activeSession : null;
  const nothingNow = !localSession && activeRemote.length === 0 && !chosen?.lastVerification;

  return (
    <section className="card" aria-labelledby="vm-execution-heading">
      <div className="card-body">
        <h2 id="vm-execution-heading" ref={heading} tabIndex={-1} className="h6 card-title">
          Run and verify
        </h2>
        {options.error && !options.data ? (
          <p className="small text-body-secondary">
            Sessions and verification are not available right now.
          </p>
        ) : null}
        {options.data && agents.length === 0 ? (
          <p className="small mb-0">No paired agent can run this VM.</p>
        ) : null}
        {options.data && chosen ? (
          <div className="row g-4">
            <div className="col-12 col-xl-5">
              <ModeSelector modes={options.data.modes} value={mode} onChange={setMode} />
              {remote ? (
                <div className="mb-3">
                  <label htmlFor="execution-version" className="form-label">
                    Version
                  </label>
                  <select
                    id="execution-version"
                    className="form-select"
                    value={selectedVersion?.versionId ?? versionId ?? ''}
                    aria-describedby="execution-version-help"
                    onChange={(event) => setVersionId(event.target.value)}
                  >
                    {versionChoices.length === 0 ? (
                      <option value="">No version available</option>
                    ) : null}
                    {versionChoices.length > 0 && !selectedVersion ? (
                      <option value={versionId ?? ''} disabled>
                        Choose a version
                      </option>
                    ) : null}
                    {versionChoices.map((item) => (
                      <option
                        key={item.versionId}
                        value={item.versionId}
                        disabled={!item.repositoryEnabled}
                      >
                        {versionLabel(item)}, {formatTime(item.createdAt)}
                        {item.repositoryEnabled ? '' : ' (repository disabled)'}
                      </option>
                    ))}
                  </select>
                  <div id="execution-version-help" className="form-text">
                    {mode === 'remote_snapshot'
                      ? 'The new snapshot’s parent is exactly this version.'
                      : 'Runs exactly this version. Nothing is kept.'}
                  </div>
                </div>
              ) : null}
              <div className="mb-2">
                <label htmlFor="execution-agent" className="form-label">
                  Agent
                </label>
                <select
                  id="execution-agent"
                  className="form-select"
                  value={chosen.agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.agentId} value={agent.agentId}>
                      {agent.agentName}
                      {agent.activeSession ? ' (running)' : agent.online ? '' : ' (offline)'}
                    </option>
                  ))}
                </select>
              </div>
              <p className="small mb-2">
                {contentText(chosen.local)}
                {chosen.local.present ? ` on ${chosen.agentName}.` : '.'}{' '}
                {remote ? 'Remote modes do not need one, and never change it. ' : ''}
                {EMULATOR_LABELS[emulatorType]} is started by the agent itself, from its own
                settings; nothing typed here becomes part of a command.
              </p>
              {allowed?.problem ? (
                <p className="small text-body-secondary mb-2">{allowed.problem}</p>
              ) : null}
              <FormError error={error} />
              {started ? (
                <div className="alert alert-info small" role="status">
                  {started}
                </div>
              ) : null}
              <div className="d-flex flex-wrap gap-2 mb-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canStart}
                  onClick={() => void act('launch')}
                >
                  {busy === 'launch'
                    ? 'Starting…'
                    : mode === 'local'
                      ? 'Launch'
                      : `Start ${MODE_TEXT[mode]}`}
                </button>
                <button
                  type="button"
                  className="btn btn-outline-primary"
                  disabled={busy !== null || !chosen.verify.eligible}
                  onClick={() => void act('verify')}
                >
                  {busy === 'verify' ? 'Starting…' : 'Verify local copy'}
                </button>
              </div>
              {allowed && !allowed.eligible && allowed.text ? (
                <p className="small text-body-secondary mb-1">
                  Cannot {mode === 'local' ? 'launch' : `start ${MODE_TEXT[mode]}`} on{' '}
                  {chosen.agentName}: {allowed.text}.
                </p>
              ) : null}
              {!chosen.verify.eligible && chosen.verify.reason ? (
                <p className="small text-body-secondary mb-0">
                  Cannot verify on {chosen.agentName}: {VERIFY_TEXT[chosen.verify.reason]}.
                </p>
              ) : null}
            </div>
            <div className="col-12 col-xl-7">
              <h3 className="h6">Now</h3>
              {nothingNow ? <p className="small text-body-secondary">Nothing is running.</p> : null}
              {localSession ? <SessionCard session={localSession} onChange={refresh} /> : null}
              {activeRemote.map((item) => (
                <RemoteSessionCard
                  key={item.id}
                  workspace={item}
                  nameVersion={nameVersion}
                  onChange={refresh}
                />
              ))}
              {chosen.lastVerification ? (
                <VerificationResult verification={chosen.lastVerification} />
              ) : null}
            </div>
          </div>
        ) : null}
        {endedRemote.length > 0 ? (
          <div className="mt-3">
            <h3 className="h6">Recent remote sessions</h3>
            <div className="table-responsive">
              <table className="table table-sm small align-middle mb-0">
                <thead>
                  <tr>
                    <th scope="col">Requested</th>
                    <th scope="col">Agent</th>
                    <th scope="col">Mode</th>
                    <th scope="col">Version</th>
                    <th scope="col">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {endedRemote.map((item) => (
                    <tr key={item.id}>
                      <td>{formatTime(item.createdAt)}</td>
                      <td>{item.agentName}</td>
                      <td>{MODE_TEXT[item.purpose as RemoteSessionMode]}</td>
                      <td>{nameVersion(item.baseVersionId)}</td>
                      <td>
                        {remoteOutcome(item, nameVersion)}
                        {item.error && item.state !== 'discarded' ? (
                          <span className="d-block text-body-secondary">{item.error.message}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {history.length > 0 ? (
          <div className="mt-3">
            <h3 className="h6">Session history</h3>
            <div className="table-responsive">
              <table className="table table-sm small mb-0">
                <thead>
                  <tr>
                    <th scope="col">Requested</th>
                    <th scope="col">Agent</th>
                    <th scope="col">Mode</th>
                    <th scope="col">State</th>
                    <th scope="col">Ended</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((session) => (
                    <tr key={session.id}>
                      <td>{formatTime(session.requestedAt)}</td>
                      <td>{session.agentName}</td>
                      <td>
                        {MODE_TEXT[session.mode]}
                        {session.workspaceId && purposeOf.get(session.workspaceId) === 'manual'
                          ? ' (manual working copy)'
                          : ''}
                      </td>
                      <td>
                        <span className={`badge ${sessionBadge(session.state)}`}>
                          {SESSION_STATE_TEXT[session.state]}
                        </span>
                        {session.error ? (
                          <span className="d-block text-body-secondary">{session.error.code}</span>
                        ) : null}
                      </td>
                      <td>
                        {session.endedAt ? formatTime(session.endedAt) : '—'}
                        {session.exitCode !== null ? ` (exit ${session.exitCode})` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The run panel over the page, for administrators: launching never means leaving it. Sessions are
 * polled only while it is open. A version and mode can be chosen beforehand, as the version history does.
 */
export function VmLaunchDialog({
  vm,
  title,
  preselect = null,
  onClose,
}: {
  vm: VmIdentity;
  title: string;
  preselect?: RunPreselection | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModalDialog(dialog, closeButton, onClose);
  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="restore-dialog run-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-dialog-title"
      >
        <div className="d-flex align-items-center gap-2 mb-2 text-white">
          <h2 id="launch-dialog-title" className="h5 mb-0 flex-grow-1">
            Launch {title}
          </h2>
          <button
            ref={closeButton}
            type="button"
            className="btn btn-sm btn-light"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <VmExecutionSection vm={vm} preselect={preselect} />
      </div>
    </div>
  );
}
