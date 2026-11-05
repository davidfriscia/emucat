import type {
  AgentSummary,
  DiscoveryEmulatorStatus,
  DiscoveryOperation,
  DiscoverySkipReason,
  DiscoverySkipped,
  DiscoveryListedVm,
  EmulatorType,
} from '@emucat/contracts';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ApiRequestError,
  fetchAgent,
  fetchDiscovery,
  revokeAgent,
  startDiscovery,
} from '../../api';
import {
  AgentFacts,
  AgentOnlineBadge,
  AgentPairingBadge,
  formatTime,
} from '../../components/Agents';
import { EmptyState, ErrorState, FormError, LoadingState } from '../../components/States';
import { usePolledData } from '../../usePolledData';
import { NotFoundPage } from '../NotFoundPage';

const AGENT_REFRESH_MS = 5_000;
const RUNNING_REFRESH_MS = 1_000;

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
    <span className="badge text-bg-success">Has a launch script for this host</span>
  ) : (
    <span className="badge text-bg-warning">No launch script for this host</span>
  );
}

function DiscoveredVmCard({ vm }: { vm: DiscoveryListedVm }) {
  return (
    <article className="card h-100">
      <div className="card-body d-flex flex-column">
        <h4 className="h6 card-title">{vm.vmName}</h4>
        <div className="d-flex flex-wrap gap-1 mb-2">
          <span className="badge text-bg-dark border">{EMULATOR_NAMES[vm.emulatorType]}</span>
          {vm.registered ? (
            <span className="badge text-bg-primary">Already registered</span>
          ) : (
            <span className="badge text-bg-secondary">Not registered</span>
          )}
          <HostCompatibility vm={vm} />
        </div>
        <p className="small text-body-secondary media-filename">{vm.markers.join(', ')}</p>
        {vm.registered ? null : (
          <div className="mt-auto">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              disabled
              title="Registration arrives in Milestone 3"
            >
              Register (Milestone 3)
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

function DiscoveryResults({ operation }: { operation: DiscoveryOperation }) {
  const truncated = operation.emulators.some((emulator) => emulator.truncated);
  return (
    <>
      <div className="alert alert-secondary small" role="note">
        <strong>These are observations, not catalog entries.</strong> Nothing here is stored or
        public. A VM joins the catalog only when you register it, which arrives in Milestone 3.
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
            <DiscoveredVmCard key={`${vm.emulatorType}/${vm.vmName}`} vm={vm} />
          ))}
        </div>
      )}
      <SkippedList skipped={operation.skipped} />
    </>
  );
}

function DiscoveryPanel({ agent }: { agent: AgentSummary }) {
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

  const unavailable =
    agent.pairingStatus === 'revoked'
      ? 'This agent has been revoked, so it can no longer discover anything.'
      : agent.online
        ? null
        : 'This agent is offline. Discovery works once it reconnects.';

  return (
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
          <DiscoveryResults operation={operation} />
        </>
      ) : null}
      {!operation && !discovery.loading && !unavailable ? (
        <p className="text-body-secondary">No discovery has run since the server started.</p>
      ) : null}
    </section>
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
    </>
  );
}
