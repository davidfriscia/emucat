import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { CaptureOperation, CaptureStatus, VmSession } from '@emucat/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CaptureScreenshot } from '../src/components/CaptureScreenshot';
import { mockApi } from './mock-api';

const id = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7005';
const operationId = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7006';
const past = '2026-01-01T00:00:00.000Z';
const session: VmSession = {
  id,
  agentId: id,
  agentName: 'Test agent',
  agentOnline: true,
  emulatorType: 'qemu',
  vmName: 'Test VM',
  mode: 'local',
  state: 'running',
  versionId: null,
  workspaceId: null,
  pid: 123,
  processStartedAt: past,
  requestedAt: past,
  startedAt: past,
  endedAt: null,
  exitCode: null,
  stopRequested: false,
  forceRequested: false,
  gracefulStopAvailable: true,
  error: null,
  recovery: null,
  requestedByDisplayName: 'Administrator',
  updatedAt: past,
};
const operation: CaptureOperation = {
  id: operationId,
  requestId: id,
  sessionId: id,
  agentId: id,
  emulatorType: 'qemu',
  vmName: 'Test VM',
  mode: 'local',
  versionId: null,
  state: 'capturing',
  sha256: null,
  mediaId: null,
  uncertain: false,
  code: null,
  message: null,
  retryAttempts: 0,
  createdAt: past,
  updatedAt: past,
};
const path = `/admin/sessions/${id}/screenshots`;

describe('session screenshot controls', () => {
  it.each(['local', 'remote_volatile', 'remote_snapshot'] as const)(
    'captures, uploads, and announces publication in %s',
    async (mode) => {
      let requested = false;
      let reads = 0;
      const published = vi.fn();
      window.addEventListener('emucat:media-published', published);
      const api = mockApi({
        [`GET ${path}`]: (): CaptureStatus => {
          if (!requested) return { available: true, reason: null, operation: null };
          reads++;
          const state = reads === 1 ? 'capturing' : reads === 2 ? 'uploading' : 'completed';
          return {
            available: state === 'completed',
            reason: null,
            operation: { ...operation, mode, state, mediaId: state === 'completed' ? id : null },
          };
        },
        [`POST ${path}`]: () => {
          requested = true;
          return { ...operation, mode };
        },
      });
      render(<CaptureScreenshot session={{ ...session, mode }} />);
      const button = await screen.findByRole('button', { name: 'Capture screenshot' });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(button);
      await screen.findByText('Capturing screenshot');
      await screen.findByText('Uploading screenshot', {}, { timeout: 4000 });
      await screen.findByText('Screenshot published.', {}, { timeout: 4000 });
      expect(screen.getByRole('link', { name: 'Open screenshot' }).getAttribute('href')).toContain(
        `/media/${id}/full`,
      );
      expect(published).toHaveBeenCalledTimes(1);
      expect(api.calls.find((call) => call.method === 'POST')?.body).toEqual({
        requestId: expect.any(String),
      });
      expect(screen.getByText(/Screenshots are public while this VM is public/)).toBeTruthy();
      window.removeEventListener('emucat:media-published', published);
    },
  );

  it('explains lost QMP and keeps the capture button disabled', async () => {
    mockApi({
      [`GET ${path}`]: {
        available: false,
        reason: 'QMP is unavailable after agent restart. Start a new VM session.',
        operation: null,
      },
    });
    render(<CaptureScreenshot session={session} />);
    await screen.findByText(/QMP is unavailable after agent restart/);
    expect(
      (screen.getByRole('button', { name: 'Capture screenshot' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('retains failure feedback and offers a bounded administrative retry', async () => {
    const api = mockApi({
      [`GET ${path}`]: {
        available: false,
        reason: null,
        operation: {
          ...operation,
          state: 'failed',
          message: 'Image exceeds upload limit',
          code: 'upload_too_large',
        },
      },
      [`POST ${path}/${operationId}/retry`]: { ...operation, state: 'uploading', retryAttempts: 1 },
    });
    render(<CaptureScreenshot session={session} />);
    await screen.findByRole('alert');
    expect(screen.getByText(/agent retains unpublished files/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry retained screenshot' }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.path.endsWith('/retry') && call.method === 'POST')).toBe(
        true,
      ),
    );
  });
});
