import { useCallback, useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { ApiRequestError, fetchSetupStatus, login } from '../api';
import { safeNextPath, useAuth } from '../auth';
import { BrandMark } from '../components/Brand';
import { FormError, LoadingState } from '../components/States';
import { useAsync } from '../useAsync';

function retryMessage(error: unknown): Error | unknown {
  if (error instanceof ApiRequestError && error.status === 429 && error.retryAfterSeconds) {
    const minutes = Math.ceil(error.retryAfterSeconds / 60);
    return new ApiRequestError(
      429,
      error.code,
      `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }
  return error;
}

export function LoginPage() {
  const [params] = useSearchParams();
  const { state: auth, signedIn } = useAuth();
  const load = useCallback((signal: AbortSignal) => fetchSetupStatus(signal), []);
  const { state: setup } = useAsync(load);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const next = safeNextPath(params.get('next'));

  if (auth.status === 'authenticated') return <Navigate to={next} replace />;
  if (auth.status === 'loading' || setup.status === 'loading') return <LoadingState />;
  if (setup.status === 'success' && setup.data.setupRequired) {
    return <Navigate to="/setup" replace />;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      signedIn(await login(username, password));
    } catch (failure) {
      setError(retryMessage(failure));
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="narrow-page">
      <title>Sign in · EmuCat</title>
      <div className="text-center mb-3">
        <BrandMark size={56} />
        <h1 className="h3 mt-2">Sign in</h1>
      </div>
      <FormError error={error} />
      <form onSubmit={(event) => void submit(event)}>
        <div className="mb-3">
          <label htmlFor="login-username" className="form-label">
            Username
          </label>
          <input
            id="login-username"
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
          <label htmlFor="login-password" className="form-label">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            className="form-control"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary w-100" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
