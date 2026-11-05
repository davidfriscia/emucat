import { Navigate, Outlet, useLocation } from 'react-router';
import { ApiRequestError } from '../api';
import { useAuth } from '../auth';
import { ErrorState, LoadingState } from './States';

/** Shows its routes only to a signed-in user, and sends anyone else to sign in and back. */
export function RequireSession() {
  const { state, retry } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'unavailable') {
    return (
      <ErrorState
        title="Cannot check your session"
        error={new ApiRequestError(0, 'unreachable', 'The server could not be reached.')}
        onRetry={retry}
      />
    );
  }
  if (state.status === 'anonymous') {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}

/** Must be nested inside {@link RequireSession}. */
export function RequireAdmin() {
  const { state } = useAuth();
  if (state.status === 'authenticated' && state.session.user.role !== 'admin') {
    return (
      <ErrorState
        title="Administrators only"
        error={new ApiRequestError(403, 'forbidden', 'This account cannot use this page.')}
      />
    );
  }
  return <Outlet />;
}
