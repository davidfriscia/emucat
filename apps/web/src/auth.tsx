import type { AuthenticatedSession } from '@emucat/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  fetchSessionState,
  logout as requestLogout,
  setCsrfToken,
  setSessionLostHandler,
} from './api';

export type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  /** The server could not say. Public pages still work; private ones offer to retry. */
  | { status: 'unavailable' }
  | { status: 'authenticated'; session: AuthenticatedSession };

interface AuthContextValue {
  state: AuthState;
  /** Adopts the session returned by signing in or by setup. */
  signedIn: (session: AuthenticatedSession) => void;
  signOut: () => Promise<void>;
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const applyAnonymous = useCallback(() => {
    setCsrfToken(null);
    setState({ status: 'anonymous' });
  }, []);

  const signedIn = useCallback((session: AuthenticatedSession) => {
    setCsrfToken(session.csrfToken);
    setState({ status: 'authenticated', session });
  }, []);

  useEffect(() => {
    setSessionLostHandler(applyAnonymous);
    return () => setSessionLostHandler(null);
  }, [applyAnonymous]);

  useEffect(() => {
    const controller = new AbortController();
    fetchSessionState(controller.signal).then(
      ({ session }) => {
        if (controller.signal.aborted) return;
        if (session) signedIn(session);
        else applyAnonymous();
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'unavailable' });
      },
    );
    return () => controller.abort();
  }, [applyAnonymous, signedIn, attempt]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      signedIn,
      signOut: async () => {
        // Whatever the server says, this browser should end up signed out.
        await requestLogout().catch(() => undefined);
        applyAnonymous();
      },
      retry: () => {
        setState({ status: 'loading' });
        setAttempt((current) => current + 1);
      },
    }),
    [state, signedIn, applyAnonymous],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** A sign-in redirect target must stay on this site, whatever the URL says. */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
    return '/admin';
  return next;
}
