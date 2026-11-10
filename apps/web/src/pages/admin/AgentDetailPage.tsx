import {
  isRegistrationCommitted,
  isRegistrationTerminal,
  type AgentSummary,
  type DiscoveryEmulatorStatus,
  type DiscoveryOperation,
  type DiscoverySkipReason,
  type DiscoverySkipped,
  type DiscoveryListedVm,
  type EmulatorType,
  type RegistrationMode,
  type RegistrationOperation,
  type RepositorySummary,
} from '@emucat/contracts';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ApiRequestError,
  fetchAgent,
  fetchDiscovery,
  fetchRegistrations,
  fetchRepositories,
  revokeAgent,
  startDiscovery,
} from '../../api';
import {
  AgentFacts,
  AgentOnlineBadge,
  AgentPairingBadge,
  formatTime,
} from '../../components/Agents';
import {
  RegistrationCard,
  RegistrationDialog,
  type RegistrationTarget,
} from '../../components/Registration';
import { EmptyState, ErrorState, FormError, LoadingState } from '../../components/States';
import { AgentRestores } from '../../components/Restore';
import { usePolledData } from '../../usePolledData';
import { NotFoundPage } from '../NotFoundPage';

const AGENT_REFRESH_MS = 5_000;
const RUNNING_REFRESH_MS = 1_000;
const REGISTRATION_ACTIVE_REFRESH_MS = 1_500;
const REGISTRATION_IDLE_REFRESH_MS = 10_000;

const EMULATOR_NAMES: Record<EmulatorType, string> = { '86box': '86Box', qemu: 'QEMU' };

const EMULATOR_STATUS_TEXT: Record<DiscoveryEmulatorStatus, string> = {
  ok: 'Scanned',
  not_configured: 'Not configured on this agent',
  base_path_missing: 'The configured directory does not exist',
  base_path_not_directory: 'The configured path is not a directory',
  base_path_inaccessible: 'The configured directory cannot be read',
};

const SKIP_REASON_TEXT: Record<DiscoverySkipReason, string> = {
  invalid_name: 'The directory’s name is not a valid VM name',
  missing_marker: 'No marker file in its root',
  marker_wrong_case: 'A marker file is present, but with different capitalization',
  reparse_point: 'A symbolic link, junction or other reparse point, which is never followed',
  not_accessible: 'The agent is not allowed to read it',
  vanished: 'It disappeared during the scan',
  duplicate_identity: 'Same name as another VM, apart from capitalization',
  too_many_entries: 'Too many files in its root to examine',
};

const NAME_ERROR_TEXT: Record<string, string> = {
  empty: 'it is empty',
  invalid_characters: 'it has characters other than ASCII letters, digits, ".", "_", "-" and space',
  too_long: 'it is longer than 64 characters',
  invalid_boundary: 'it must start and end with a letter or digit',
  repeated_separator: 'it contains ".." or consecutive spaces',
  reserved_name: 'it is a reserved Windows device name',
  snapshot_suffix: 'it ends like a snapshot name',
};

function HostCompatibility({ vm }: { vm: DiscoveryListedVm }) {
  if (vm.hostCompatible === null) return null;
  return vm.hostCompatible ? (
    <span className="badge text-bg-success">Has a launcher for this host</span>
  ) : (
    <span className="badge text-bg-warning">No launcher for this host</span>
  );
}

interface VmActions {
  /** Why nothing can be started right now, or null if it can. */
  blocked: string | null;
  running: ReadonlySet<string>;
  /** Registered since this report was made. The report itself says nothing about that. */
  registered: ReadonlySet<string>;
  onChoose: (vm: DiscoveryListedVm, mode: Exclude<RegistrationMode, 'snapshot'>) => void;
}

const vmKey = (emulatorType: string, vmName: string) => `${emulatorType}/${vmName.toLowerCase()}`;

function DiscoveredVmCard({ vm, actions }: { vm: DiscoveryListedVm; actions: VmActions }) {
  const key = vmKey(vm.emulatorType, vm.vmName);
  const running = actions.running.has(key);
  const registered = vm.registered || actions.registered.has(key);
  const title = actions.blocked ?? undefined;
  return (
    <article className="card h-100">
      <div className="card-body d-flex flex-column">
        <h4 className="h6 card-title">{vm.vmName}</h4>
        <div className="d-flex flex-wrap gap-1 mb-2">
          <span className="badge text-bg-dark border">{EMULATOR_NAMES[vm.emulatorType]}</span>
          {registered ? (
            <span className="badge text-bg-primary">Already registered</span>
          ) : running ? (
            <span className="badge text-bg-info">Registration running</span>
          ) : (
            <span className="badge text-bg-secondary">Not registered</span>
          )}
          <HostCompatibility vm={vm} />
        </div>
        <p className="small text-body-secondary media-filename">
          Launchers: {vm.markers.join(', ')}
        </p>
        {registered || running ? null : (
          <div className="mt-auto d-flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={actions.blocked !== null}
              title={title}
              onClick={() => actions.onChoose(vm, 'copy')}
            >
              Copy to remote
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              disabled={actions.blocked !== null}
              title={title}
              onClick={() => actions.onChoose(vm, 'transfer')}
            >
              Transfer to remote
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function SkippedList({ skipped }: { skipped: DiscoverySkipped[] }) {
  if (skipped.length === 0) return null;
  return (
    <section className="mt-4">
      <h3 className="h6">Skipped directories</h3>
      <ul className="list-group">
        {skipped.map((entry) => (
          <li key={`${entry.emulatorType}/${entry.name}`} className="list-group-item">
            <span className="fw-medium media-filename">{entry.name || '(unnamed)'}</span>{' '}
            <span className="badge text-bg-dark border">{EMULATOR_NAMES[entry.emulatorType]}</span>
            <div className="small text-body-secondary">
              {SKIP_REASON_TEXT[entry.reason]}
              {entry.nameError ? `: ${NAME_ERROR_TEXT[entry.nameError] ?? entry.nameError}` : ''}.
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DiscoveryResults({
  operation,
  actions,
}: {
  operation: DiscoveryOperation;
  actions: VmActions;
}) {
  const truncated = operation.emulators.some((emulator) => emulator.truncated);
  return (
    <>
      <div className="alert alert-secondary small" role="note">
        <strong>These are observations, not catalog entries.</strong> Nothing here is stored or
        public. A VM joins the catalog, privately, only when you register it with Copy or Transfer.
      </div>
      <ul className="list-unstyled small mb-3">
        {operation.emulators.map((emulator) => (
          <li key={emulator.emulatorType}>
            <strong>{EMULATOR_NAMES[emulator.emulatorType]}:</strong>{' '}
            {EMULATOR_STATUS_TEXT[emulator.status]}
            {emulator.truncated ? ', and stopped at a limit' : ''}
          </li>
        ))}
      </ul>
      {truncated ? (
        <div className="alert alert-warning" role="alert">
          This report is incomplete, because a limit on its size or duration was reached.
        </div>
      ) : null}
      {operation.vms.length === 0 ? (
        <EmptyState title="No virtual machines found">
          The agent looked directly inside its configured directories and found no directory with a
          marker file.
        </EmptyState>
      ) : (
        <div className="media-grid">
          {operation.vms.map((vm) => (
            <DiscoveredVmCard key={`${vm.emulatorType}/${vm.vmName}`} vm={vm} actions={actions} />
          ))}
        </div>
      )}
      <SkippedList skipped={operation.skipped} />
    </>
  );
}

function usableRepository(
  repositories: RepositorySummary[],
  agentId: string,
): RepositorySummary | null {
  return (
    repositories.find(
      (repository) =>
        repository.enabled && repository.agents.some((agent) => agent.agentId === agentId),
    ) ?? null
  );
}

function RegistrationsPanel({
  operations,
  error,
  onChanged,
}: {
  operations: RegistrationOperation[];
  error: unknown;
  onChanged: () => void;
}) {
  if (operations.length === 0) return null;
  return (
    <section className="mt-4" aria-labelledby="registrations-heading">
      <h2 className="h5" id="registrations-heading">
        Registrations
      </h2>
      <p className="text-body-secondary">
        These keep going if you leave this page, and survive a server restart.
      </p>
      {error ? (
        <div className="alert alert-warning" role="alert">
          The server cannot be reached right now. Still trying.
        </div>
      ) : null}
      <div className="d-grid gap-3">
        {operations.map((operation) => (
          <RegistrationCard key={operation.id} operation={operation} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}

function DiscoveryPanel({ agent }: { agent: AgentSummary }) {
  const loadRepositories = useCallback((signal: AbortSignal) => fetchRepositories(signal), []);
  const repositories = usePolledData(loadRepositories, REGISTRATION_IDLE_REFRESH_MS);
  const [active, setActive] = useState(false);
  const loadRegistrations = useCallback(
    (signal: AbortSignal) => fetchRegistrations(agent.id, signal),
    [agent.id],
  );
  const registrations = usePolledData(
    loadRegistrations,
    active ? REGISTRATION_ACTIVE_REFRESH_MS : REGISTRATION_IDLE_REFRESH_MS,
  );
  const operations = registrations.data?.operations ?? [];
  const activeOperations = operations.filter(
    (operation) => !isRegistrationTerminal(operation.state),
  );
  const isActive = activeOperations.length > 0;
  if (active !== isActive) setActive(isActive);
  const [choice, setChoice] = useState<{
    target: RegistrationTarget;
    mode: Exclude<RegistrationMode, 'snapshot'>;
  } | null>(null);

  const [running, setRunning] = useState(false);
  const load = useCallback((signal: AbortSignal) => fetchDiscovery(agent.id, signal), [agent.id]);
  const discovery = usePolledData(load, running ? RUNNING_REFRESH_MS : null);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);

  const operation = discovery.data?.operation ?? null;
  const isRunning = operation?.status === 'running';
  if (running !== isRunning) setRunning(isRunning);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await startDiscovery(agent.id);
      discovery.setData({ operation: started });
      setRunning(started.status === 'running');
    } catch (failure) {
      setError(failure);
      if (failure instanceof ApiRequestError) discovery.refresh();
    } finally {
      setStarting(false);
    }
  };

  const repository = usableRepository(repositories.data?.repositories ?? [], agent.id);
  const blocked =
    agent.pairingStatus === 'revoked'
      ? 'This agent has been revoked'
      : !agent.online
        ? 'This agent is offline'
        : !repository
          ? 'This agent is not allowed to use a repository yet'
          : isActive
            ? 'This agent is already running a registration'
            : null;
  const actions: VmActions = {
    blocked,
    running: new Set(
      activeOperations.map((operation) => vmKey(operation.emulatorType, operation.vmName)),
    ),
    registered: new Set(
      operations
        .filter((operation) => isRegistrationCommitted(operation.state))
        .map((operation) => vmKey(operation.emulatorType, operation.vmName)),
    ),
    onChoose: (vm, mode) => {
      if (!operation) return;
      setChoice({
        mode,
        target: {
          agentId: agent.id,
          agentName: agent.name,
          emulatorType: vm.emulatorType,
          vmName: vm.vmName,
          discoveryOperationId: operation.id,
        },
      });
    },
  };

  const unavailable =
    agent.pairingStatus === 'revoked'
      ? 'This agent has been revoked, so it can no longer discover anything.'
      : agent.online
        ? null
        : 'This agent is offline. Discovery works once it reconnects.';

  return (
    <>
      <div id="registrations" />
      <RegistrationsPanel
        operations={operations}
        error={registrations.error}
        onChanged={registrations.refresh}
      />
      <section className="mt-4">
        <h2 className="h5">Discovery</h2>
        <p className="text-body-secondary">
          Asks the agent to look, read-only, inside its configured VM directories.
        </p>
        {unavailable ? (
          <div className="alert alert-secondary" role="status">
            {unavailable}
          </div>
        ) : null}
        <FormError error={error} />
        <button
          type="button"
          className="btn btn-primary mb-3"
          disabled={!!unavailable || starting || isRunning}
          onClick={() => void start()}
        >
          {isRunning ? 'Discovering…' : 'Discover virtual machines'}
        </button>
        {discovery.error ? (
          <div className="alert alert-warning" role="alert">
            The server cannot be reached right now. Still trying.
          </div>
        ) : null}
        {isRunning ? (
          <div className="alert alert-info" role="status">
            <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
            The agent is scanning. This page updates by itself.
          </div>
        ) : null}
        {operation?.status === 'failed' ? (
          <div className="alert alert-danger" role="alert">
            {operation.failure?.message ?? 'Discovery failed.'} Nothing was changed.
          </div>
        ) : null}
        {operation?.status === 'completed' ? (
          <>
            <p className="small text-body-secondary">
              Finished at {formatTime(operation.finishedAt)}.
            </p>
            {agent.online && agent.pairingStatus !== 'revoked' && !repository ? (
              <div className="alert alert-secondary small" role="status">
                To register a VM, first <Link to="/admin/repositories">allow this agent</Link> to
                use a repository.
              </div>
            ) : null}
            <DiscoveryResults operation={operation} actions={actions} />
          </>
        ) : null}
        {!operation && !discovery.loading && !unavailable ? (
          <p className="text-body-secondary">No discovery has run since the server started.</p>
        ) : null}
        {choice && repository ? (
          <RegistrationDialog
            target={choice.target}
            mode={choice.mode}
            repository={repository}
            onClose={() => setChoice(null)}
            onStarted={() => {
              setChoice(null);
              setActive(true);
              registrations.refresh();
              // Its progress appears above the list this was started from.
              document.getElementById('registrations')?.scrollIntoView?.();
            }}
          />
        ) : null}
      </section>
    </>
  );
}

function RevokeControl({ agent, onRevoked }: { agent: AgentSummary; onRevoked: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (agent.pairingStatus === 'revoked') return null;

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await revokeAgent(agent.id);
      setConfirming(false);
      onRevoked();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <FormError error={error} />
      {confirming ? (
        <>
          <p>
            <strong>Revoke {agent.name}?</strong> It is disconnected at once and its credential
            stops working. Its VM files are not touched, and catalog history is kept. To use it
            again you must pair it again.
          </p>
          <div className="d-flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void revoke()}
            >
              Confirm revocation
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary theme-button"
              onClick={() => setConfirming(false)}
            >
              Keep this agent
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-outline-danger"
          onClick={() => setConfirming(true)}
        >
          Revoke
        </button>
      )}
    </div>
  );
}

export function AgentDetailPage() {
  const { agentId = '' } = useParams();
  const load = useCallback((signal: AbortSignal) => fetchAgent(agentId, signal), [agentId]);
  const { data: agent, error, loading, refresh } = usePolledData(load, AGENT_REFRESH_MS);

  const notFound = error instanceof ApiRequestError && [400, 404].includes(error.status);
  if (notFound) return <NotFoundPage />;
  if (loading) return <LoadingState label="Loading the agent" />;
  if (!agent) return <ErrorState error={error} onRetry={refresh} />;

  return (
    <>
      <title>{`${agent.name} · EmuCat`}</title>
      <p className="mb-2">
        <Link to="/admin/agents">All agents</Link>
      </p>
      <h1 className="h3 mb-2">{agent.name}</h1>
      <div className="d-flex flex-wrap gap-1 mb-3">
        <AgentOnlineBadge agent={agent} />
        <AgentPairingBadge agent={agent} />
      </div>
      {error ? (
        <div className="alert alert-warning" role="alert">
          The server cannot be reached right now. What you see may be out of date.
        </div>
      ) : null}
      {agent.pairingStatus === 'revoked' ? (
        <div className="alert alert-danger" role="status">
          Revoked at {formatTime(agent.revokedAt)}. To use that computer again, run{' '}
          <code>emucat-agent pair --force</code> there and approve it as a new agent.
        </div>
      ) : null}
      <AgentFacts agent={agent} />
      <dl className="settings-facts small">
        <dt>Protocol</dt>
        <dd>{agent.protocolVersion ?? 'Not reported yet'}</dd>
        <dt>Paired at</dt>
        <dd>{formatTime(agent.pairedAt)}</dd>
        <dt>Approved by</dt>
        <dd>{agent.ownerDisplayName ?? 'Unknown'}</dd>
        <dt>Last connected</dt>
        <dd>{formatTime(agent.lastConnectedAt)}</dd>
      </dl>
      <RevokeControl agent={agent} onRevoked={refresh} />
      <DiscoveryPanel agent={agent} />
      <AgentRestores agentId={agent.id} />
    </>
  );
}
