import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useModalDialog } from './Gallery';
import { FormError } from './States';

/** Whether what was typed is the VM's name. Names are compared as the server compares them. */
export function nameMatches(typed: string, vmName: string): boolean {
  return typed.trim().toLowerCase() === vmName.toLowerCase();
}

/**
 * A small confirmation, so that every consequential action is a deliberate one. With `confirmName`, that
 * name has to be typed first. Focus goes in when it opens and Escape closes it; the opener puts the focus
 * back, because only the opener knows where it was.
 */
export function ConfirmDialog({
  title,
  children,
  action,
  danger = false,
  confirmName,
  cancelLabel = 'Cancel',
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  action: string;
  danger?: boolean;
  confirmName?: string | undefined;
  cancelLabel?: string;
  onConfirm: (typed: string | undefined) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement & HTMLButtonElement>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useModalDialog(dialog, first, onClose);
  const matches = confirmName === undefined || nameMatches(typed, confirmName);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(confirmName === undefined ? undefined : typed.trim());
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <form className="card-body" onSubmit={(event) => void submit(event)}>
          <h2 id="confirm-dialog-title" className="h5 card-title">
            {title}
          </h2>
          <div className="small mb-3">{children}</div>
          <FormError error={error} />
          {confirmName !== undefined ? (
            <>
              <label htmlFor="confirm-vm-name" className="form-label">
                Type <span className="vm-identity">{confirmName}</span> to confirm
              </label>
              <input
                id="confirm-vm-name"
                ref={first}
                className="form-control mb-3"
                autoComplete="off"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </>
          ) : null}
          <div className="d-flex flex-wrap gap-2">
            <button
              type="submit"
              ref={confirmName === undefined ? first : undefined}
              className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
              disabled={busy || !matches}
            >
              {busy ? 'Working…' : action}
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary theme-button"
              onClick={onClose}
            >
              {cancelLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The typed confirmation that destructive actions need, with the warning in a danger alert. */
export function ConfirmByName({
  title,
  vmName,
  explanation,
  action,
  cancelLabel = 'Cancel',
  onConfirm,
  onClose,
}: {
  title: string;
  vmName: string;
  explanation: string;
  action: string;
  cancelLabel?: string;
  onConfirm: (typed: string) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      title={title}
      action={action}
      danger
      confirmName={vmName}
      cancelLabel={cancelLabel}
      onClose={onClose}
      onConfirm={(typed) => onConfirm(typed ?? '')}
    >
      <div className="alert alert-danger small mb-0" role="alert">
        {explanation}
      </div>
    </ConfirmDialog>
  );
}

/** A dialog that only shows something, with a Close button. */
export function InfoDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useModalDialog(dialog, close, onClose);
  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-dialog-title"
      >
        <div className="card-body">
          <div className="d-flex align-items-start gap-2 mb-3">
            <h2 id="info-dialog-title" className="h5 card-title mb-0 flex-grow-1">
              {title}
            </h2>
            <button
              ref={close}
              type="button"
              className="btn btn-sm btn-outline-secondary theme-button"
              onClick={onClose}
            >
              Close
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
