import type {
  AgentSummary,
  RepositoryAgent,
  RepositorySummary,
  SaveRepositoryRequest,
} from '@emucat/contracts';
import { useCallback, useState, type FormEvent } from 'react';
import {
  associateRepositoryAgent,
  checkRepository,
  createRepository,
  dissociateRepositoryAgent,
  fetchAgents,
  fetchRepositories,
  updateRepository,
} from '../../api';
import { formatBytes, formatTime } from '../../components/Agents';
import { EmptyState, ErrorState, FormError, LoadingState } from '../../components/States';
import { usePolledData } from '../../usePolledData';

const REFRESH_MS = 3_000;

const STATUS_BADGES = {
  unchecked: ['text-bg-secondary', 'Not checked yet'],
  healthy: ['text-bg-success', 'Healthy'],
  failing: ['text-bg-danger', 'Failing'],
} as const;

const EMPTY_FORM: SaveRepositoryRequest = {
  name: '',
  host: '',
  port: 22,
  username: '',
  remoteRoot: '',
};

function RepositoryForm({
  initial,
  submitLabel,
  onSave,
  onCancel,
}: {
  initial: SaveRepositoryRequest;
  submitLabel: string;
  onSave: (request: SaveRepositoryRequest) => Promise<void>;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const update = (field: keyof SaveRepositoryRequest) => (event: { target: { value: string } }) =>
    setForm({
      ...form,
      [field]: field === 'port' ? Number(event.target.value) : event.target.value,
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(form);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="mb-3">
      <FormError error={error} />
      <div className="row g-2">
        <div className="col-12 col-md-6">
          <label className="form-label" htmlFor="repository-name">
            Name
          </label>
          <input
            id="repository-name"
            className="form-control"
            required
            value={form.name}
            onChange={update('name')}
          />
        </div>
        <div className="col-12 col-md-4">
          <label className="form-label" htmlFor="repository-host">
            Host
          </label>
          <input
            id="repository-host"
            className="form-control"
            required
            value={form.host}
            onChange={update('host')}
          />
        </div>
        <div className="col-12 col-md-2">
          <label className="form-label" htmlFor="repository-port">
            Port
          </label>
          <input
            id="repository-port"
            className="form-control"
            type="number"
            min={1}
            max={65535}
            required
            value={form.port}
            onChange={update('port')}
          />
        </div>
        <div className="col-12 col-md-6">
          <label className="form-label" htmlFor="repository-username">
            SSH user
          </label>
          <input
            id="repository-username"
            className="form-control"
            required
            value={form.username}
            onChange={update('username')}
          />
        </div>
        <div className="col-12 col-md-6">
          <label className="form-label" htmlFor="repository-root">
            Remote root
          </label>
          <input
            id="repository-root"
            className="form-control"
            required
            placeholder="/emucat"
            value={form.remoteRoot}
            onChange={update('remoteRoot')}
          />
        </div>
      </div>
      <div className="form-text mb-2">
        These details say where the repository is. The private key stays on each agent, and is never
        sent here.
      </div>
      <div className="d-flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel ? (
          <button
            type="button"
            className="btn btn-outline-secondary theme-button"
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

function AssociatedAgent({
  repository,
  agent,
  onChanged,
}: {
  repository: RepositorySummary;
  agent: RepositoryAgent;
  onChanged: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="list-group-item">
      <div className="d-flex flex-wrap justify-content-between gap-2">
        <div>
          <strong>{agent.agentName}</strong>{' '}
          {agent.revoked ? (
            <span className="badge text-bg-danger">Revoked</span>
          ) : agent.online ? (
            <span className="badge text-bg-success">Online</span>
          ) : (
            <span className="badge text-bg-secondary">Offline</span>
          )}
          <div className="small text-body-secondary">
            Last checked: {formatTime(agent.lastCheckedAt)}. Last success:{' '}
            {formatTime(agent.lastSuccessAt)}.
            {agent.freeBytes !== null ? ` Free space: ${formatBytes(agent.freeBytes)}.` : ''}
          </div>
          {agent.hostKeyFingerprint ? (
            <div className="small text-body-secondary text-break">
              Trusted host key: <code>{agent.hostKeyFingerprint}</code>
            </div>
          ) : null}
        </div>
        <div className="d-flex flex-wrap gap-2 align-items-start">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || agent.checkInProgress || !agent.online}
            onClick={() => void act(() => checkRepository(repository.id, agent.agentId))}
          >
            {agent.checkInProgress ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary theme-button"
            disabled={busy}
            onClick={() => void act(() => dissociateRepositoryAgent(repository.id, agent.agentId))}
          >
            Remove
          </button>
        </div>
      </div>
      {agent.errorMessage ? (
        <div className="alert alert-danger small mt-2 mb-0" role="alert">
          {agent.errorMessage}
        </div>
      ) : null}
      <FormError error={error} />
    </li>
  );
}

function RepositoryCard({
  repository,
  agents,
  onChanged,
}: {
  repository: RepositorySummary;
  agents: AgentSummary[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [badge, statusText] = STATUS_BADGES[repository.status];
  const available = agents.filter(
    (agent) =>
      agent.pairingStatus === 'paired' &&
      !repository.agents.some((associated) => associated.agentId === agent.id),
  );

  const associate = async () => {
    setError(null);
    try {
      await associateRepositoryAgent(repository.id, chosen);
      setChosen('');
      onChanged();
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <article className="card mb-3">
      <div className="card-body">
        <h2 className="h5 card-title">{repository.name}</h2>
        <div className="d-flex flex-wrap gap-1 mb-2">
          <span className={`badge ${badge}`}>{statusText}</span>
          <span className="badge text-bg-dark border">SSH/SFTP</span>
          {repository.enabled ? null : <span className="badge text-bg-secondary">Disabled</span>}
        </div>
        {editing ? (
          <RepositoryForm
            initial={{
              name: repository.name,
              host: repository.host,
              port: repository.port,
              username: repository.username,
              remoteRoot: repository.remoteRoot,
            }}
            submitLabel="Save"
            onCancel={() => setEditing(false)}
            onSave={async (request) => {
              await updateRepository(repository.id, request);
              setEditing(false);
              onChanged();
            }}
          />
        ) : (
          <>
            <dl className="settings-facts small">
              <dt>UUID</dt>
              <dd className="text-break">
                <code>{repository.id}</code>
              </dd>
              <dt>Host</dt>
              <dd>
                {repository.host}:{repository.port}
              </dd>
              <dt>SSH user</dt>
              <dd>{repository.username}</dd>
              <dt>Remote root</dt>
              <dd className="text-break">{repository.remoteRoot}</dd>
              <dt>Last successful check</dt>
              <dd>{formatTime(repository.lastSuccessfulCheckAt)}</dd>
            </dl>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary theme-button mb-3"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </>
        )}

        <h3 className="h6">Agents allowed to use it</h3>
        <p className="small text-body-secondary">
          Each one also needs this repository’s UUID, a private key and a trusted host key in its
          own configuration. See <code>docs/repositories.md</code>.
        </p>
        {repository.agents.length > 0 ? (
          <ul className="list-group mb-3">
            {repository.agents.map((agent) => (
              <AssociatedAgent
                key={agent.agentId}
                repository={repository}
                agent={agent}
                onChanged={onChanged}
              />
            ))}
          </ul>
        ) : (
          <div className="alert alert-secondary small" role="status">
            No agent is allowed to use this repository yet.
          </div>
        )}
        <FormError error={error} />
        {available.length > 0 ? (
          <div className="d-flex flex-wrap gap-2">
            <select
              className="form-select form-select-sm w-auto"
              aria-label="Agent to allow"
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
            >
              <option value="">Choose an agent…</option>
              {available.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!chosen}
              onClick={() => void associate()}
            >
              Allow
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function RepositoriesPage() {
  const load = useCallback(async (signal: AbortSignal) => {
    const [repositories, agents] = await Promise.all([
      fetchRepositories(signal),
      fetchAgents(signal),
    ]);
    return { repositories: repositories.repositories, agents: agents.agents };
  }, []);
  const { data, error, loading, refresh } = usePolledData(load, REFRESH_MS);

  if (loading) return <LoadingState label="Loading repositories" />;
  if (!data) return <ErrorState error={error} onRetry={refresh} />;

  return (
    <>
      <title>Repositories · EmuCat</title>
      <h1 className="h3 mb-2">Repositories</h1>
      <p className="text-body-secondary">
        Where VM archives are stored. Agents reach a repository directly over SSH, so archives never
        pass through this server.
      </p>
      {error ? (
        <div className="alert alert-warning" role="alert">
          The server cannot be reached right now. What you see may be out of date.
        </div>
      ) : null}
      {data.repositories.map((repository) => (
        <RepositoryCard
          key={repository.id}
          repository={repository}
          agents={data.agents}
          onChanged={refresh}
        />
      ))}
      {data.repositories.length === 0 ? (
        <>
          <EmptyState title="No repository yet">
            Describe your SSH server below. Then allow an agent to use it, and test the connection.
          </EmptyState>
          <RepositoryForm
            initial={EMPTY_FORM}
            submitLabel="Create the repository"
            onSave={async (request) => {
              await createRepository(request);
              refresh();
            }}
          />
        </>
      ) : null}
    </>
  );
}
