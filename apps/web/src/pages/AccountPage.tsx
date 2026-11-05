import { PASSWORD_MIN_LENGTH } from '@emucat/contracts';
import { useCallback, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  ApiRequestError,
  changePassword,
  fetchSessions,
  revokeOtherSessions,
  revokeSession,
} from '../api';
import { useAuth } from '../auth';
import { ErrorState, FormError, LoadingState } from '../components/States';
import { useAsync } from '../useAsync';

const formatTime = (timestamp: string) => new Date(timestamp).toLocaleString();

function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    if (next !== confirmation) {
      setError(new ApiRequestError(400, 'validation_failed', 'The two passwords do not match.'));
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirmation('');
      setSaved(true);
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <FormError error={error} />
      {saved ? (
        <div className="alert alert-success" role="status">
          Password changed. Your other sessions have been signed out.
        </div>
      ) : null}
      <div className="mb-3">
        <label htmlFor="current-password" className="form-label">
          Current password
        </label>
        <input
          id="current-password"
          type="password"
          className="form-control"
          autoComplete="current-password"
          required
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </div>
      <div className="mb-3">
        <label htmlFor="new-password" className="form-label">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          className="form-control"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          required
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
        <div className="form-text">At least {PASSWORD_MIN_LENGTH} characters.</div>
      </div>
      <div className="mb-3">
        <label htmlFor="confirm-password" className="form-label">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          type="password"
          className="form-control"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={submitting}>
        Change password
      </button>
    </form>
  );
}

function SessionList() {
  const load = useCallback((signal: AbortSignal) => fetchSessions(signal), []);
  const { state, reload } = useAsync(load);
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);

  if (state.status === 'loading') return <LoadingState label="Loading your sessions" />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={reload} />;

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      reload();
    } catch (failure) {
      setError(failure);
    }
  };
  const others = state.data.sessions.filter((session) => !session.current).length;

  return (
    <>
      <FormError error={error} />
      <ul className="list-group mb-3">
        {state.data.sessions.map((session) => (
          <li
            className="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2"
            key={session.id}
          >
            <div className="small">
              <div className="fw-medium">
                {session.current ? 'This browser' : 'Another session'}{' '}
                {session.current ? <span className="badge text-bg-success">Current</span> : null}
              </div>
              <div className="text-body-secondary">
                Signed in {formatTime(session.createdAt)}, last active{' '}
                {formatTime(session.lastSeenAt)}, expires {formatTime(session.expiresAt)}
              </div>
            </div>
            {session.current ? null : (
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                onClick={() => void act(() => revokeSession(session.id))}
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-outline-danger"
          disabled={others === 0}
          onClick={() => void act(revokeOtherSessions)}
        >
          Sign out everywhere else
        </button>
        <button
          type="button"
          className="btn btn-outline-secondary theme-button"
          onClick={() => {
            // Leave first: this page would otherwise react by redirecting to sign-in.
            void Promise.resolve(navigate('/')).then(signOut);
          }}
        >
          Sign out here
        </button>
      </div>
    </>
  );
}

export function AccountPage() {
  const { state } = useAuth();
  const [sessionsVersion, setSessionsVersion] = useState(0);
  if (state.status !== 'authenticated') return null;
  const { user } = state.session;

  return (
    <>
      <title>Account · EmuCat</title>
      <h1 className="h3 mb-4">Account</h1>
      <div className="settings-grid mb-4">
        <section className="card">
          <div className="card-body">
            <h2 className="h6 card-title">Profile</h2>
            <dl className="mb-0 small settings-facts">
              <dt>Name</dt>
              <dd>{user.displayName}</dd>
              <dt>Username</dt>
              <dd>{user.username}</dd>
              <dt>Role</dt>
              <dd>{user.role === 'admin' ? 'Administrator' : 'User'}</dd>
            </dl>
          </div>
        </section>
        <section className="card">
          <div className="card-body">
            <h2 className="h6 card-title">Password</h2>
            <PasswordForm onChanged={() => setSessionsVersion((version) => version + 1)} />
          </div>
        </section>
      </div>
      <section>
        <h2 className="h5">Sessions</h2>
        {/* Remounted after a password change, which revokes the other sessions. */}
        <SessionList key={sessionsVersion} />
      </section>
    </>
  );
}
