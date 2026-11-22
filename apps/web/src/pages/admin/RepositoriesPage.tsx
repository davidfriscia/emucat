import {
  SERVER_CONNECTION_STEP_TEXT,
  type AgentSummary,
  type RepositoryAgent,
  type RepositorySummary,
  type SaveRepositoryRequest,
  type ServerConnectionTest,
} from '@emucat/contracts';
import { useCallback, useState, type FormEvent } from 'react';
import {
  associateRepositoryAgent,
  checkRepository,
  createRepository,
  dissociateRepositoryAgent,
  fetchAgents,
  fetchRepositories,
  testServerConnection,
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
  serverHost: null,
  serverPort: null,
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
  const update = (field: keyof SaveRepositoryRequest) => (event: { target: { value: string } }) => {
    const value = event.target.value;
    // The server's own address is optional: empty means "the same as the agents'".
    const optional = field === 'serverHost' || field === 'serverPort';
    setForm({
      ...form,
      [field]:
        optional && value.trim() === ''
          ? null
          : field === 'port' || field === 'serverPort'
            ? Number(value)
            : value,
    });
  };

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
      <fieldset className="row g-2 mt-1">
        <legend className="col-12 h6 mb-0 fs-6">Server’s own address (optional)</legend>
        <div className="col-12 col-md-4">
          <label className="form-label" htmlFor="repository-server-host">
            Server host
          </label>
          <input
            id="repository-server-host"
            className="form-control"
            placeholder="Same as Host"
            value={form.serverHost ?? ''}
            aria-describedby="repository-server-help"
            onChange={update('serverHost')}
          />
        </div>
        <div className="col-12 col-md-2">
          <label className="form-label" htmlFor="repository-server-port">
            Server port
          </label>
          <input
            id="repository-server-port"
            className="form-control"
            type="number"
            min={1}
            max={65535}
            placeholder={String(form.port)}
            value={form.serverPort ?? ''}
            aria-describedby="repository-server-help"
            onChange={update('serverPort')}
          />
        </div>
        <div id="repository-server-help" className="col-12 form-text mt-0">
          Where the EmuCat server itself reaches the same SSH server, if not at Host and Port: for
          example an internal name or a VPN address. It is used for clones, View Archive Contents
          and the relay for agents that cannot reach the repository. The user and remote root are
          the same.
        </div>
      </fieldset>
      <div className="form-text mb-2">
        These details say where the repository is. Private keys are never entered here: each agent
        keeps its own, and the server’s own key is a file on the server (see the deployment guide).
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
            {agent.transport === 'relay'
              ? ' Reached through the server relay.'
              : agent.transport === 'sftp'
                ? ' Reached directly over SFTP.'
                : ''}
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

/**
 * The server's own connection to the repository (decision 0055), tested step by step. The steps say what failed and
 * what to do; they never show a key or a server path.
 */
function ServerConnection({
  repository,
  onChanged,
}: {
  repository: RepositorySummary;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<ServerConnectionTest | null>(null);
  const shown = result ?? repository.serverAccess.lastTest;
  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await testServerConnection(repository.id));
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-3" aria-labelledby={`server-connection-${repository.id}`}>
      <h3 className="h6" id={`server-connection-${repository.id}`}>
        Server connection
      </h3>
      <p className="small text-body-secondary mb-2">
        The EmuCat server’s own SSH connection, used for clones, View Archive Contents and the relay
        for agents that cannot reach the repository themselves.{' '}
        {repository.serverAccess.configured
          ? 'This server has a key and a known_hosts file for it.'
          : 'This server has no key for repositories yet: see the deployment guide.'}
      </p>
      <button
        type="button"
        className="btn btn-sm btn-primary mb-2"
        disabled={busy}
        onClick={() => void test()}
      >
        {busy ? 'Testing…' : 'Test Server Connection'}
      </button>
      <FormError error={error} />
      {shown ? (
        <div
          className={`alert ${shown.ok ? 'alert-success' : 'alert-danger'} small mb-0`}
          role="status"
        >
          <div>
            {shown.ok ? 'The server can use this repository.' : 'The server cannot use it.'} Tested{' '}
            {formatTime(shown.testedAt)} at {shown.address.host}:{shown.address.port}
            {shown.address.source === 'server' ? ' (server address)' : ''}.
            {shown.freeBytes !== null ? ` Free space: ${formatBytes(shown.freeBytes)}.` : ''}
          </div>
          {shown.hostKeyFingerprint ? (
            <div className="text-break">
              Host key: <code>{shown.hostKeyFingerprint}</code>
            </div>
          ) : null}
          <ul className="list-unstyled mb-0 mt-1">
            {shown.steps.map((step) => (
              <li key={step.step}>
                <span aria-hidden="true">
                  {step.ok === true ? '✓' : step.ok === false ? '✗' : '–'}
                </span>{' '}
                <strong>{SERVER_CONNECTION_STEP_TEXT[step.step]}</strong>
                <span className="visually-hidden">
                  {step.ok === true ? ': passed' : step.ok === false ? ': failed' : ': not reached'}
                </span>
                {step.message ? ` — ${step.message}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
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
              serverHost: repository.serverHost,
              serverPort: repository.serverPort,
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
              {repository.serverHost !== null || repository.serverPort !== null ? (
                <>
                  <dt>Server address</dt>
                  <dd>
                    {repository.serverHost ?? repository.host}:
                    {repository.serverPort ?? repository.port}
                  </dd>
                </>
              ) : null}
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

        <ServerConnection repository={repository} onChanged={onChanged} />

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
        Where VM archives are stored. Agents reach a repository directly over SSH when they can. An
        agent that cannot may send and fetch archives through this server, which then uses its own
        connection; clones are made by this server too.
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
