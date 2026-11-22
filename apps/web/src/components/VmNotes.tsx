import { type VmIdentity, type VmNotes } from '@emucat/contracts';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, clearVmNotes, fetchVmNotes, saveVmNotes } from '../api';
import { useAsync } from '../useAsync';
import { formatTime } from './Agents';
import { ConfirmDialog } from './Dialogs';
import { useDocumentTheme } from '../theme';
import { FormError, LoadingState } from './States';

// Vditor is large, and only administrators editing or reading notes need it: it is loaded then, not with the app.
const MarkdownEditor = lazy(() =>
  import('./MarkdownEditor').then((module) => ({ default: module.MarkdownEditor })),
);
const MarkdownView = lazy(() =>
  import('./MarkdownEditor').then((module) => ({ default: module.MarkdownView })),
);

/**
 * A VM's notes: one Markdown document about the VM itself, for administrators only (decision 0053). It belongs to the
 * VM's identity, not to a version, so nothing a version does changes it, and a clone starts with none.
 */
export function VmNotesSection({ vm, title }: { vm: VmIdentity; title: string }) {
  const { emulatorType, vmName } = vm;
  const load = useCallback(
    (signal: AbortSignal) => fetchVmNotes({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const { state, reload, setData } = useAsync(load);
  const theme = useDocumentTheme();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [confirming, setConfirming] = useState<'discard' | 'clear' | null>(null);
  const [saved, setSaved] = useState(false);
  /** A new editor, with the text it is given, each time this changes. */
  const [editorKey, setEditorKey] = useState(0);
  const editButton = useRef<HTMLButtonElement>(null);

  const notes = state.status === 'success' ? state.data : null;
  const dirty = editing && notes !== null && draft !== notes.markdown;

  // Leaving the page with unsaved notes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const startEditing = (current: VmNotes) => {
    setDraft(current.markdown);
    setError(null);
    setConflict(false);
    setSaved(false);
    setEditing(true);
  };

  const stopEditing = () => {
    setEditing(false);
    setConfirming(null);
    setError(null);
    setConflict(false);
    // Back to where editing started.
    requestAnimationFrame(() => editButton.current?.focus());
  };

  const save = async () => {
    if (!notes) return;
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const next = await saveVmNotes(vm, draft, notes.etag);
      setData(next);
      setSaved(true);
      stopEditing();
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.code === 'notes_conflict') {
        setConflict(true);
      } else {
        setError(failure);
      }
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (dirty) setConfirming('discard');
    else stopEditing();
  };

  return (
    <section className="mt-4 vm-notes" aria-labelledby="vm-notes-heading">
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <h2 id="vm-notes-heading" className="h5 mb-0">
          Notes
        </h2>
        {dirty ? (
          <span className="badge text-bg-warning" role="status">
            Unsaved changes
          </span>
        ) : null}
        {notes?.updatedAt && !editing ? (
          <span className="small text-body-secondary">Saved {formatTime(notes.updatedAt)}</span>
        ) : null}
        <div className="ms-auto d-flex flex-wrap gap-2">
          {notes && !editing ? (
            <>
              <button
                ref={editButton}
                type="button"
                className="btn btn-sm btn-outline-primary"
                aria-label={`Edit notes of ${title}`}
                onClick={() => startEditing(notes)}
              >
                {notes.exists ? 'Edit notes' : 'Add notes'}
              </button>
              {notes.exists ? (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-danger"
                  aria-haspopup="dialog"
                  onClick={() => setConfirming('clear')}
                >
                  Clear…
                </button>
              ) : null}
            </>
          ) : null}
          {editing ? (
            <>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save notes'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary theme-button"
                disabled={saving}
                onClick={cancel}
              >
                Cancel
              </button>
            </>
          ) : null}
        </div>
      </div>
      <p className="small text-body-secondary mb-2">
        Private to administrators. Notes belong to this VM, not to a version: snapshots, restores
        and remasters leave them as they are, and a clone starts without them.
      </p>
      {state.status === 'loading' ? <LoadingState label="Loading the notes" /> : null}
      {state.status === 'error' ? (
        <div className="alert alert-danger small" role="alert">
          The notes could not be loaded
          {state.error instanceof ApiRequestError ? `: ${state.error.message}` : '.'}{' '}
          <button type="button" className="btn btn-sm btn-link p-0" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}
      {saved && !editing ? (
        <div className="alert alert-success small py-2" role="status">
          Notes saved.
        </div>
      ) : null}
      {conflict ? (
        <div className="alert alert-warning small" role="alert">
          <strong>The notes were changed elsewhere</strong> since you started editing, so nothing
          was saved. Copy what you need from your text, then reload the current notes.{' '}
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary theme-button ms-1"
            onClick={() => {
              void fetchVmNotes(vm).then((current) => {
                setData(current);
                setDraft(current.markdown);
                setConflict(false);
                setEditorKey((key) => key + 1);
              }, setError);
            }}
          >
            Reload current notes
          </button>
        </div>
      ) : null}
      <FormError error={error} />
      {notes && editing ? (
        <Suspense fallback={<LoadingState label="Loading the editor" />}>
          <MarkdownEditor
            key={editorKey}
            initialValue={draft}
            onChange={setDraft}
            label={`Notes of ${title}, in Markdown`}
            theme={theme}
          />
        </Suspense>
      ) : null}
      {notes && !editing ? (
        notes.exists ? (
          <div className="card">
            <div className="card-body">
              <Suspense fallback={<LoadingState label="Loading the notes" />}>
                <MarkdownView markdown={notes.markdown} theme={theme} label={`Notes of ${title}`} />
              </Suspense>
            </div>
          </div>
        ) : (
          <p className="small text-body-secondary">
            No notes yet. Installation steps, configuration, installed software and known issues fit
            well here.
          </p>
        )
      ) : null}
      {confirming === 'discard' ? (
        <ConfirmDialog
          title="Discard your changes?"
          action="Discard changes"
          danger
          cancelLabel="Keep editing"
          onClose={() => setConfirming(null)}
          onConfirm={async () => stopEditing()}
        >
          The notes stay as they were saved.
        </ConfirmDialog>
      ) : null}
      {confirming === 'clear' && notes ? (
        <ConfirmDialog
          title={`Clear the notes of ${title}?`}
          action="Clear notes"
          danger
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            const next = await clearVmNotes(vm, notes.etag);
            setData(next);
            setConfirming(null);
          }}
        >
          The notes file is deleted from the server. This cannot be undone.
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
