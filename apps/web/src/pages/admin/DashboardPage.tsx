import { useCallback } from 'react';
import { Link } from 'react-router';
import { fetchAdminSummary } from '../../api';
import { useAuth } from '../../auth';
import { RegistrationNote } from '../../components/Catalog';
import { ErrorState, LoadingState } from '../../components/States';
import { useAsync } from '../../useAsync';

function Stat({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <section className="card">
      <div className="card-body">
        <h2 className="h6 card-title text-body-secondary">{label}</h2>
        <div className="stat-value">{value}</div>
        <div className="small text-body-secondary">{detail}</div>
      </div>
    </section>
  );
}

export function DashboardPage() {
  const { state: auth } = useAuth();
  const load = useCallback((signal: AbortSignal) => fetchAdminSummary(signal), []);
  const { state, reload } = useAsync(load);
  const name = auth.status === 'authenticated' ? auth.session.user.displayName : '';

  return (
    <>
      <title>Dashboard · EmuCat</title>
      <h1 className="h3 mb-1">Dashboard</h1>
      <p className="text-body-secondary mb-4">Signed in as {name}.</p>
      {state.status === 'loading' ? <LoadingState label="Loading the summary" /> : null}
      {state.status === 'error' ? <ErrorState error={state.error} onRetry={reload} /> : null}
      {state.status === 'success' ? (
        <div className="settings-grid mb-4">
          <Stat
            label="Virtual machines"
            value={state.data.vms.total}
            detail={`${state.data.vms.public} public, ${state.data.vms.private} private`}
          />
          <Stat
            label="Media"
            value={state.data.media.total}
            detail={`${state.data.media.public} public, ${state.data.media.private} private, by their VM`}
          />
        </div>
      ) : null}
      <RegistrationNote />
      <Link to="/admin/catalog" className="btn btn-primary">
        Manage the catalog
      </Link>
    </>
  );
}
