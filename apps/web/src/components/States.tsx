import type { ReactNode } from 'react';
import { ApiRequestError } from '../api';
import { Mascot } from './Brand';

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="d-flex justify-content-center py-5" role="status">
      <div className="spinner-border text-primary" aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="state-panel text-center rounded-3 border px-3 py-5">
      <Mascot mood="sleeping" size={96} />
      <h2 className="h5 mt-3">{title}</h2>
      <p className="text-body-secondary mx-auto mb-0 state-panel-text">{children}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </section>
  );
}

export function describeError(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'Something went wrong.';
}

export function ErrorState({
  title = 'That did not work',
  error,
  onRetry,
}: {
  title?: string;
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <section className="state-panel text-center rounded-3 border px-3 py-5" role="alert">
      <Mascot mood="puzzled" size={96} />
      <h2 className="h5 mt-3">{title}</h2>
      <p className="text-body-secondary mx-auto mb-0 state-panel-text">{describeError(error)}</p>
      {onRetry ? (
        <button type="button" className="btn btn-outline-primary mt-3" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </section>
  );
}

/** A problem with a form: the message, then whatever each field got wrong. */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const details = error instanceof ApiRequestError ? error.details : [];
  return (
    <div className="alert alert-danger" role="alert">
      {describeError(error)}
      {details.length > 0 ? (
        <ul className="mb-0 mt-1">
          {details.map((detail) => (
            <li key={`${detail.path}:${detail.message}`}>
              {detail.path ? `${detail.path}: ` : ''}
              {detail.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
