import {
  EMULATOR_LABELS,
  isSessionActive,
  type ExecutionAgentOption,
  type ExecutionMode,
  type ExecutionOptionsResponse,
  type LaunchIneligibleReason,
  type VerifyIneligibleReason,
  type VmIdentity,
  type VmSession,
  type VmSessionState,
  type VmVerification,
} from '@emucat/contracts';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import {
  dismissSession,
  fetchExecutionOptions,
  fetchVmSessions,
  launchVm,
  stopSession,
  verifyLocalCopy,
} from '../api';
import { usePolledData } from '../usePolledData';
import { formatBytes, formatTime } from './Agents';
import { useModalDialog } from './Gallery';
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

const MODE_TEXT: Record<ExecutionMode, string> = {
  local: 'Local',
  remote_volatile: 'Remote volatile',
  remote_snapshot: 'Remote snapshot',
};

const MODE_EXPLANATION: Record<ExecutionMode, string> = {
  local:
    'The emulator runs on the agent’s computer, on its local copy. Changes stay in that copy, and the master is never touched.',
  remote_volatile: 'Runs remotely, and discards every change when it ends.',
  remote_snapshot: 'Runs remotely, and keeps its changes as a new snapshot.',
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
  verified: 'Verified: identical to the master',
  modified: 'Modified: differs from the master',
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
      return 'Local copy differs from the master';
    default:
      return 'Local copy, not verified';
  }
}

/** The typed confirmation that a forced stop and a dismissal both need. */
function ConfirmByName({
  title,
  vmName,
  explanation,
  action,
  onConfirm,
  onClose,
}: {
  title: string;
  vmName: string;
  explanation: string;
  action: string;
  onConfirm: (typed: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useModalDialog(dialog, input, onClose);
  const matches = typed.trim().toLowerCase() === vmName.toLowerCase();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(typed.trim());
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <form className="card-body" onSubmit={(event) => void submit(event)}>
          <h2 id="confirm-dialog-title" className="h5 card-title">
            {title}
          </h2>
          <div className="alert alert-danger small" role="alert">
            {explanation}
          </div>
          <FormError error={error} />
          <label htmlFor="confirm-vm-name" className="form-label">
            Type <span className="vm-identity">{vmName}</span> to confirm
          </label>
          <input
            id="confirm-vm-name"
            ref={input}
            className="form-control mb-3"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <div className="d-flex flex-wrap gap-2">
            <button type="submit" className="btn btn-danger" disabled={busy || !matches}>
              {action}
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary theme-button"
              onClick={onClose}
            >
              Keep it running
            </button>
          </div>
        </form>
      </div>
    </div>
  );
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

/** Launching, stopping and verifying this VM on an agent, and its sessions. Administrators only. */
export function VmExecutionSection({ vm }: { vm: VmIdentity }) {
  const { emulatorType, vmName } = vm;
  const loadOptions = useCallback(
    (signal: AbortSignal) => fetchExecutionOptions({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const loadSessions = useCallback(
    (signal: AbortSignal) => fetchVmSessions({ emulatorType, vmName, limit: 10 }, signal),
    [emulatorType, vmName],
  );
  const [fastPoll, setFastPoll] = useState(false);
  const options = usePolledData(loadOptions, fastPoll ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  const sessions = usePolledData(loadSessions, fastPoll ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [mode, setMode] = useState<ExecutionMode>('local');
  const [busy, setBusy] = useState<'launch' | 'verify' | null>(null);
  const [error, setError] = useState<unknown>(null);
  // One request per intent: a retry after a lost response finds the session it already started.
  const requestId = useRef<string>(crypto.randomUUID());

  const agents = options.data?.agents ?? [];
  const chosen =
    agents.find((agent) => agent.agentId === agentId) ??
    agents.find((agent) => agent.launch.eligible || agent.activeSession) ??
    agents[0];
  const history = sessions.data?.sessions ?? [];

  const transitional =
    history.some((session) => ['requested', 'starting', 'stopping'].includes(session.state)) ||
    agents.some((agent) => agent.lastVerification?.state === 'requested');
  if (transitional !== fastPoll) setFastPoll(transitional);

  const refresh = () => {
    options.refresh();
    sessions.refresh();
  };

  const act = async (kind: 'launch' | 'verify') => {
    if (!chosen) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'launch') {
        await launchVm({
          agentId: chosen.agentId,
          emulatorType,
          vmName,
          mode,
          requestId: requestId.current,
        });
        requestId.current = crypto.randomUUID();
      } else {
        await verifyLocalCopy({ agentId: chosen.agentId, emulatorType, vmName });
      }
      refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(null);
    }
  };

  const modeAvailable = options.data?.modes.find((item) => item.mode === mode)?.available ?? false;

  return (
    <section className="card" aria-labelledby="vm-execution-heading">
      <div className="card-body">
        <h2 id="vm-execution-heading" className="h6 card-title">
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
          <>
            <ModeSelector modes={options.data.modes} value={mode} onChange={setMode} />
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
              {EMULATOR_LABELS[emulatorType]} is started by the agent itself, from its own settings;
              nothing typed here becomes part of a command.
            </p>
            {chosen.launch.problem ? (
              <p className="small text-body-secondary mb-2">{chosen.launch.problem}</p>
            ) : null}
            <FormError error={error} />
            <div className="d-flex flex-wrap gap-2 mb-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null || !chosen.launch.eligible || !modeAvailable}
                onClick={() => void act('launch')}
              >
                {busy === 'launch' ? 'Launching…' : 'Launch'}
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
            {!chosen.launch.eligible && chosen.launch.reason ? (
              <p className="small text-body-secondary mb-1">
                Cannot launch on {chosen.agentName}: {LAUNCH_TEXT[chosen.launch.reason]}.
              </p>
            ) : null}
            {!chosen.verify.eligible && chosen.verify.reason ? (
              <p className="small text-body-secondary mb-2">
                Cannot verify on {chosen.agentName}: {VERIFY_TEXT[chosen.verify.reason]}.
              </p>
            ) : null}
            {chosen.activeSession ? (
              <SessionCard session={chosen.activeSession} onChange={refresh} />
            ) : null}
            {chosen.lastVerification ? (
              <VerificationResult verification={chosen.lastVerification} />
            ) : null}
          </>
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
                      <td>{MODE_TEXT[session.mode]}</td>
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
 * The VM page's Launch action, for administrators: the same controls as on the management page, over the
 * page, so that launching never means leaving it. Sessions are polled only while it is open.
 */
export function VmLaunchDialog({
  vm,
  title,
  onClose,
}: {
  vm: VmIdentity;
  title: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModalDialog(dialog, closeButton, onClose);
  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="restore-dialog"
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
        <VmExecutionSection vm={vm} />
      </div>
    </div>
  );
}
