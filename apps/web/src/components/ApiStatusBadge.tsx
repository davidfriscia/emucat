import type { ApiStatus } from '../api';
import { useApiStatus } from '../useApiStatus';

const PRESENTATION: Record<ApiStatus, { label: string; title: string; dot: string }> = {
  checking: { label: 'Checking API', title: 'Contacting the API', dot: 'bg-secondary' },
  online: { label: 'API online', title: 'The API and database are ready', dot: 'bg-success' },
  degraded: {
    label: 'API degraded',
    title: 'The API is running, but the database or schema is not ready',
    dot: 'bg-warning',
  },
  offline: { label: 'API offline', title: 'The API cannot be reached', dot: 'bg-danger' },
};

export function ApiStatusBadge() {
  const { label, title, dot } = PRESENTATION[useApiStatus()];
  return (
    <span
      className="api-status d-inline-flex align-items-center gap-2 small text-body-secondary"
      role="status"
      title={title}
    >
      <span className={`api-status-dot rounded-circle ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}
