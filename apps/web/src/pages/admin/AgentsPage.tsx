import {
  formatPairingCode,
  normalizePairingCode,
  type AgentSummary,
  type PairingRequestReview,
} from '@emucat/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  ApiRequestError,
  approvePairing,
  fetchAgents,
  fetchPairingRequest,
  fetchPendingPairingRequests,
  lookUpPairing,
  rejectPairing,
} from '../../api';
import {
  AgentFacts,
  AgentOnlineBadge,
  AgentPairingBadge,
  describePlatform,
  formatTime,
} from '../../components/Agents';
import { EmptyState, ErrorState, FormError, LoadingState } from '../../components/States';
import { usePolledData } from '../../usePolledData';

const LIST_REFRESH_MS = 5_000;
const COLLECTION_REFRESH_MS = 2_000;

function PairingIdentity({ request }: { request: PairingRequestReview }) {
  return (
    <dl className="settings-facts mb-3">
      <dt>Name</dt>
      <dd>{request.name}</dd>
      <dt>Platform</dt>
      <dd>{describePlatform(request.platform, request.architecture)}</dd>
      <dt>Version</dt>
      <dd>
        {request.agentVersion} (protocol {request.protocolVersion})
      </dd>
      <dt>Requested from</dt>
      <dd>{request.requestedFrom}</dd>
      <dt>Requested at</dt>
      <dd>{formatTime(request.createdAt)}</dd>
      <dt>Expires at</dt>
      <dd>{formatTime(request.expiresAt)}</dd>
    </dl>
  );
}

/** After approval, follows the request until the agent has its credential. */
function CollectionProgress({
  request,
  onFinished,
}: {
  request: PairingRequestReview;
  onFinished: () => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) => fetchPairingRequest(request.id, signal),
    [request.id],
  );
  const [settled, setSettled] = useState(false);
  const { data, error } = usePolledData(load, settled ? null : COLLECTION_REFRESH_MS);
  const current = data ?? request;
  const finished = current.status === 'completed' || current.status === 'expired';
  if (finished && !settled) setSettled(true);
  useEffect(() => {
    if (finished) onFinished();
  }, [finished, onFinished]);
  if (current.status === 'completed') {
    return (
      <div className="alert alert-success" role="status">
        <strong>{current.name}</strong> is paired. Start it with <code>emucat-agent run</code>, and
        it comes online below.{' '}
        {current.agentId ? (
          <Link to={`/admin/agents/${current.agentId}`}>View this agent</Link>
        ) : null}
      </div>
    );
  }
  if (current.status === 'expired') {
    return (
      <div className="alert alert-warning" role="alert">
        The agent did not collect its credential in time, so nothing was paired. Run{' '}
        <code>emucat-agent pair</code> again.
      </div>
    );
  }
  return (
    <div className="alert alert-info" role="status">
      <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
      Approved. Waiting for <strong>{current.name}</strong> to collect its credential.
      {error ? ' The server cannot be reached right now; still trying.' : null}
    </div>
  );
}

function PairingPanel({ onChanged }: { onChanged: () => void }) {
  const [code, setCode] = useState('');
  const [review, setReview] = useState<PairingRequestReview | null>(null);
  const [approved, setApproved] = useState<PairingRequestReview | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure);
      // A request that has expired or been decided elsewhere cannot be acted on any more.
      if (
        failure instanceof ApiRequestError &&
        ['pairing_expired', 'pairing_already_decided'].includes(failure.code)
      ) {
        setReview(null);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleLookup = (event: FormEvent) => {
    event.preventDefault();
    setApproved(null);
    setRejected(null);
    void act(async () => {
      setReview(await lookUpPairing(code));
    });
  };

  const startOver = () => {
    setReview(null);
    setCode('');
    setError(null);
  };

  const normalized = normalizePairingCode(code);

  return (
    <section className="card mb-4">
      <div className="card-body">
        <h2 className="h5 card-title">Pair an agent</h2>
        <p className="text-body-secondary">
          On the computer running the agent, run <code>emucat-agent pair</code>. It prints a code.
          Enter that code here, then check that the details are that computer’s before you approve.
        </p>
        <FormError error={error} />
        {approved ? <CollectionProgress request={approved} onFinished={onChanged} /> : null}
        {rejected ? (
          <div className="alert alert-secondary" role="status">
            The pairing request from <strong>{rejected}</strong> was rejected.
          </div>
        ) : null}
        {review ? (
          <>
            <h3 className="h6">Is this the agent you are pairing?</h3>
            <PairingIdentity request={review} />
            <div className="d-flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setApproved(await approvePairing(review.id, code));
                    startOver();
                    onChanged();
                  })
                }
              >
                Approve
              </button>
              <button
                type="button"
                className="btn btn-outline-danger"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await rejectPairing(review.id);
                    setRejected(review.name);
                    startOver();
                    onChanged();
                  })
                }
              >
                Reject
              </button>
              <button
                type="button"
                className="btn btn-outline-secondary theme-button"
                disabled={busy}
                onClick={startOver}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleLookup} className="pairing-form">
            <label htmlFor="pairing-code" className="form-label">
              Pairing code
            </label>
            <div className="d-flex flex-wrap gap-2">
              <input
                id="pairing-code"
                className="form-control pairing-code-input"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={32}
                placeholder="ABCD-2345"
                aria-describedby="pairing-code-help"
              />
              <button type="submit" className="btn btn-primary" disabled={busy || !normalized}>
                Review
              </button>
            </div>
            <div id="pairing-code-help" className="form-text">
              {normalized
                ? `Will look up ${formatPairingCode(normalized)}.`
                : 'Eight letters and digits. Case and dashes do not matter.'}
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

function PendingRequests({
  requests,
  onChanged,
}: {
  requests: PairingRequestReview[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  if (requests.length === 0) return null;

  const reject = async (request: PairingRequestReview) => {
    setBusyId(request.id);
    setError(null);
    try {
      await rejectPairing(request.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusyId(null);
      onChanged();
    }
  };

  return (
    <section className="mb-4">
      <h2 className="h5">Waiting for approval</h2>
      <p className="text-body-secondary small">
        Approving needs the code the agent displays. If you do not recognize a request, reject it,
        or leave it to expire: it grants nothing by itself.
      </p>
      <FormError error={error} />
      <div className="settings-grid">
        {requests.map((request) => (
          <article key={request.id} className="card">
            <div className="card-body">
              <h3 className="h6 card-title">{request.name}</h3>
              <PairingIdentity request={request} />
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                disabled={busyId === request.id}
                onClick={() => void reject(request)}
              >
                Reject
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function AgentCard({ agent }: { agent: AgentSummary }) {
  return (
    <article className="card h-100">
      <div className="card-body d-flex flex-column">
        <h3 className="h6 card-title">
          <Link to={`/admin/agents/${agent.id}`}>{agent.name}</Link>
        </h3>
        <div className="d-flex flex-wrap gap-1 mb-2">
          <AgentOnlineBadge agent={agent} />
          <AgentPairingBadge agent={agent} />
        </div>
        <AgentFacts agent={agent} />
        <div className="mt-auto">
          <Link
            to={`/admin/agents/${agent.id}`}
            className="btn btn-sm btn-outline-primary"
            aria-label={`Manage ${agent.name}`}
          >
            {agent.online ? 'Discover and manage' : 'Manage'}
          </Link>
        </div>
      </div>
    </article>
  );
}

export function AgentsPage() {
  const loadAgents = useCallback((signal: AbortSignal) => fetchAgents(signal), []);
  const loadPending = useCallback((signal: AbortSignal) => fetchPendingPairingRequests(signal), []);
  const agents = usePolledData(loadAgents, LIST_REFRESH_MS);
  const pending = usePolledData(loadPending, LIST_REFRESH_MS);
  const { refresh: refreshAgents } = agents;
  const { refresh: refreshPending } = pending;
  const refresh = useCallback(() => {
    refreshAgents();
    refreshPending();
  }, [refreshAgents, refreshPending]);

  return (
    <>
      <title>Agents · EmuCat</title>
      <h1 className="h3 mb-1">Agents</h1>
      <p className="text-body-secondary mb-4">
        An agent runs on a computer that holds virtual machines, and connects out to this server.
      </p>
      {agents.error && agents.data ? (
        <div className="alert alert-warning" role="alert">
          The server cannot be reached right now. What you see may be out of date, and this page
          will catch up by itself when it returns.
        </div>
      ) : null}
      <PairingPanel onChanged={refresh} />
      <PendingRequests requests={pending.data?.requests ?? []} onChanged={refresh} />

      <h2 className="h5">Paired agents</h2>
      {agents.loading ? <LoadingState label="Loading the agents" /> : null}
      {agents.error && !agents.data ? (
        <ErrorState error={agents.error} onRetry={agents.refresh} />
      ) : null}
      {agents.data?.agents.length === 0 ? (
        <EmptyState title="No agents yet">
          Pair the first one with the form above. Until then there is nothing to discover VMs with.
        </EmptyState>
      ) : null}
      {agents.data && agents.data.agents.length > 0 ? (
        <div className="media-grid">
          {agents.data.agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      ) : null}
    </>
  );
}
