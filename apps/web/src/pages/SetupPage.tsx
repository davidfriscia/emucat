import { PASSWORD_MIN_LENGTH, setupRequestSchema } from '@emucat/contracts';
import { useCallback, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { ApiRequestError, completeSetup, fetchSetupStatus } from '../api';
import { useAuth } from '../auth';
import { Mascot } from '../components/Brand';
import { EmptyState, ErrorState, FormError, LoadingState } from '../components/States';
import { useAsync } from '../useAsync';

function localProblem(message: string): ApiRequestError {
  return new ApiRequestError(400, 'validation_failed', message);
}

/** Explicit, one-time creation of the first administrator on a fresh installation. */
export function SetupPage() {
  const { state: auth, signedIn } = useAuth();
  const load = useCallback((signal: AbortSignal) => fetchSetupStatus(signal), []);
  const { state: status, reload } = useAsync(load);
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (auth.status === 'authenticated') return <Navigate to="/admin" replace />;
  if (status.status === 'loading') return <LoadingState />;
  if (status.status === 'error') return <ErrorState error={status.error} onRetry={reload} />;
  if (!status.data.setupRequired) {
    return (
      <EmptyState
        title="Setup is complete"
        action={
          <Link to="/login" className="btn btn-primary">
            Sign in
          </Link>
        }
      >
        This installation already has an administrator.
      </EmptyState>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirmation) {
      setError(localProblem('The two passwords do not match.'));
      return;
    }
    const request = setupRequestSchema.safeParse({
      setupToken: setupToken.trim(),
      username,
      displayName,
      password,
    });
    if (!request.success) {
      setError(localProblem(request.error.issues[0]?.message ?? 'Check the form and try again.'));
      return;
    }
    setSubmitting(true);
    try {
      signedIn(await completeSetup(request.data));
    } catch (failure) {
      setError(failure);
      // Someone else finished setup first: the page should now say so.
      if (failure instanceof ApiRequestError && failure.code === 'setup_completed') reload();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="narrow-page">
      <title>Set up · EmuCat</title>
      <div className="text-center mb-3">
        <Mascot size={96} />
        <h1 className="h3 mt-2">Welcome to EmuCat</h1>
        <p className="text-body-secondary">Create the administrator for this installation.</p>
      </div>
      <FormError error={error} />
      <form onSubmit={(event) => void submit(event)}>
        <div className="mb-3">
          <label htmlFor="setup-token" className="form-label">
            Setup token
          </label>
          <input
            id="setup-token"
            type="password"
            className="form-control"
            autoComplete="off"
            required
            value={setupToken}
            aria-describedby="setup-token-help"
            onChange={(event) => setSetupToken(event.target.value)}
          />
          <div id="setup-token-help" className="form-text">
            The API printed this to its log when it started, unless you set <code>SETUP_TOKEN</code>{' '}
            in its environment. It proves you operate this server.
          </div>
        </div>
        <div className="mb-3">
          <label htmlFor="setup-username" className="form-label">
            Username
          </label>
          <input
            id="setup-username"
            className="form-control"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
        <div className="mb-3">
          <label htmlFor="setup-display-name" className="form-label">
            Display name
          </label>
          <input
            id="setup-display-name"
            className="form-control"
            autoComplete="name"
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div className="mb-3">
          <label htmlFor="setup-password" className="form-label">
            Password
          </label>
          <input
            id="setup-password"
            type="password"
            className="form-control"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            required
            value={password}
            aria-describedby="setup-password-help"
            onChange={(event) => setPassword(event.target.value)}
          />
          <div id="setup-password-help" className="form-text">
            At least {PASSWORD_MIN_LENGTH} characters.
          </div>
        </div>
        <div className="mb-3">
          <label htmlFor="setup-confirmation" className="form-label">
            Confirm password
          </label>
          <input
            id="setup-confirmation"
            type="password"
            className="form-control"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary w-100" disabled={submitting}>
          {submitting ? 'Creating the administrator…' : 'Create administrator'}
        </button>
      </form>
    </div>
  );
}
