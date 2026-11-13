import { adminMediaPath, type VmIdentity, type VmSession } from '@emucat/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { captureScreenshot, fetchCaptureStatus, retryCapture } from '../api';
import { usePolledData } from '../usePolledData';
import { FormError } from './States';

const EVENT = 'emucat:media-published';

/** Refresh only the matching gallery and keep its current content and focus during the fetch. */
export function useCaptureGalleryRefresh(vm: VmIdentity, refresh: () => void) {
  useEffect(() => {
    const listener = (event: Event) => {
      const identity = (event as CustomEvent<VmIdentity>).detail;
      if (identity.emulatorType === vm.emulatorType && identity.vmName === vm.vmName) refresh();
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [vm.emulatorType, vm.vmName, refresh]);
}

export function CaptureScreenshot({ session }: { session: VmSession }) {
  const load = useCallback(
    (signal: AbortSignal) => fetchCaptureStatus(session.id, signal),
    [session.id],
  );
  const status = usePolledData(load, 1500);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef<string | null>(null);
  const completed = useRef<string | null>(null);
  const help = useId();
  const capture = status.data?.operation;
  const completedId = capture?.state === 'completed' ? capture.id : null;
  useEffect(() => {
    if (completedId && completed.current !== completedId) {
      completed.current = completedId;
      requestId.current = null;
      window.dispatchEvent(
        new CustomEvent(EVENT, {
          detail: { emulatorType: session.emulatorType, vmName: session.vmName },
        }),
      );
    }
  }, [completedId, session.emulatorType, session.vmName]);

  const start = async (retry: boolean) => {
    setBusy(true);
    setError(null);
    const id = requestId.current ?? crypto.randomUUID();
    if (!retry) requestId.current = id;
    try {
      if (retry && capture) await retryCapture(session.id, capture.id);
      else await captureScreenshot(session.id, id);
      requestId.current = null;
      status.refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  if (session.emulatorType !== 'qemu') return null;
  if (session.state !== 'running' && !capture) return null;
  const pending = capture && ['requested', 'capturing', 'uploading'].includes(capture.state);
  return (
    <section className="mt-2" aria-label="QEMU screenshot capture">
      <div className="d-flex flex-wrap align-items-center gap-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          disabled={
            busy ||
            session.state !== 'running' ||
            !session.agentOnline ||
            !status.data?.available ||
            Boolean(pending)
          }
          aria-describedby={help}
          onClick={() => void start(false)}
        >
          Capture screenshot
        </button>
        {capture?.state === 'failed' && capture.retryAttempts < 3 ? (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            disabled={busy || !session.agentOnline}
            onClick={() => void start(true)}
          >
            Retry retained screenshot
          </button>
        ) : null}
        {capture?.state === 'completed' && capture.mediaId ? (
          <a
            href={adminMediaPath(session, capture.mediaId, 'full')}
            target="_blank"
            rel="noreferrer"
          >
            Open screenshot
          </a>
        ) : null}
      </div>
      <p id={help} className="small text-body-secondary mt-1 mb-1">
        Screenshots are public while this VM is public.
        {status.data?.reason ? ` ${status.data.reason}` : ''}
      </p>
      <div role="status" aria-live="polite" className="small">
        {busy || capture?.state === 'requested' || capture?.state === 'capturing'
          ? 'Capturing screenshot'
          : capture?.state === 'uploading'
            ? 'Uploading screenshot'
            : capture?.state === 'completed'
              ? 'Screenshot published.'
              : ''}
      </div>
      {capture?.state === 'failed' ? (
        <p role="alert" className="small text-danger mb-1">
          {capture.message ?? 'Screenshot capture failed.'} The agent retains unpublished files.
          Retry only uploads or recovers a complete retained image; it does not take another
          screenshot.
        </p>
      ) : null}
      {status.error ? (
        <p role="status" className="small text-body-secondary">
          Capture status is temporarily unavailable; checking again.
        </p>
      ) : null}
      <FormError error={error} />
    </section>
  );
}
