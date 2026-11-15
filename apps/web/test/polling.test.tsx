import type { CaptureStatus, VmSession } from '@emucat/contracts';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureScreenshot } from '../src/components/CaptureScreenshot';
import { usePolledData } from '../src/usePolledData';
import { mockApi, resetApiState } from './mock-api';

const SESSION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f73';
const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f63';
const CAPTURE_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f75';
const WHEN = '2026-11-15T10:00:00.000Z';

let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetApiState();
});

/** Lets timers and the promises they start run, as `ms` pass. */
async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setHidden(value: boolean) {
  act(() => {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('polled data', () => {
  it('requests once at first, then once per interval', async () => {
    const load = vi.fn(async () => 'data');
    renderHook(() => usePolledData(load, 1_000));
    await elapse(0);
    expect(load).toHaveBeenCalledTimes(1);
    await elapse(3_000);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('only reschedules when the interval changes, without a request of its own', async () => {
    const load = vi.fn(async () => 'data');
    const { rerender } = renderHook(({ interval }) => usePolledData(load, interval), {
      initialProps: { interval: 10_000 as number | null },
    });
    await elapse(0);
    rerender({ interval: 2_000 });
    rerender({ interval: 10_000 });
    rerender({ interval: 2_000 });
    await elapse(0);
    expect(load).toHaveBeenCalledTimes(1);
    await elapse(2_000);
    expect(load).toHaveBeenCalledTimes(2);
    rerender({ interval: null });
    await elapse(60_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stops when unmounted', async () => {
    const load = vi.fn(async () => 'data');
    const { unmount } = renderHook(() => usePolledData(load, 1_000));
    await elapse(0);
    unmount();
    await elapse(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses while the tab is hidden, and catches up when it shows', async () => {
    const load = vi.fn(async () => 'data');
    renderHook(() => usePolledData(load, 1_000));
    await elapse(0);
    setHidden(true);
    await elapse(30_000);
    expect(load).toHaveBeenCalledTimes(1);
    setHidden(false);
    await elapse(0);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('requests at once on refresh', async () => {
    const load = vi.fn(async () => 'data');
    const { result } = renderHook(() => usePolledData(load, null));
    await elapse(0);
    act(() => result.current.refresh());
    await elapse(0);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

function session(state: VmSession['state']): VmSession {
  return {
    id: SESSION_ID,
    agentId: AGENT_ID,
    agentName: 'Desk PC',
    agentOnline: true,
    emulatorType: 'virtualbox',
    vmName: 'xenix-386',
    mode: 'local',
    state,
    versionId: null,
    workspaceId: null,
    pid: null,
    processStartedAt: null,
    requestedAt: WHEN,
    startedAt: WHEN,
    endedAt: state === 'running' ? null : WHEN,
    exitCode: null,
    stopRequested: false,
    forceRequested: false,
    gracefulStopAvailable: true,
    error: null,
    recovery: null,
    requestedByDisplayName: 'Ada Admin',
    updatedAt: WHEN,
  };
}

function capture(
  state: NonNullable<CaptureStatus['operation']>['state'],
): NonNullable<CaptureStatus['operation']> {
  return {
    id: CAPTURE_ID,
    requestId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f77',
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    emulatorType: 'virtualbox',
    vmName: 'xenix-386',
    mode: 'local',
    versionId: null,
    uncertain: false,
    state,
    sha256: null,
    mediaId: state === 'completed' ? '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f76' : null,
    code: null,
    message: null,
    retryAttempts: 0,
    createdAt: WHEN,
    updatedAt: WHEN,
  };
}

const STATUS_PATH = `/admin/sessions/${SESSION_ID}/screenshots`;

describe('screenshot capture status', () => {
  it('is read once for a session that ended, and never polled', async () => {
    const api = mockApi({
      [`GET ${STATUS_PATH}`]: { available: false, reason: null, operation: capture('completed') },
    });
    render(<CaptureScreenshot session={session('stopped')} />);
    await elapse(0);
    await elapse(5 * 60_000);
    expect(api.callsTo('GET', STATUS_PATH)).toHaveLength(1);
  });

  it('is followed slowly while the session runs, and quickly only while a capture is pending', async () => {
    let state: Parameters<typeof capture>[0] | null = null;
    const api = mockApi({
      [`GET ${STATUS_PATH}`]: () => ({
        available: true,
        reason: null,
        operation: state ? capture(state) : null,
      }),
    });
    const published = vi.fn();
    window.addEventListener('emucat:media-published', published);
    render(<CaptureScreenshot session={session('running')} />);
    await elapse(0);
    expect(api.callsTo('GET', STATUS_PATH)).toHaveLength(1);
    await elapse(14_000);
    expect(api.callsTo('GET', STATUS_PATH)).toHaveLength(1);
    await elapse(1_000);
    expect(api.callsTo('GET', STATUS_PATH)).toHaveLength(2);

    // A capture started elsewhere is seen at the next read, then followed every 2 seconds.
    state = 'uploading';
    await elapse(15_000);
    const pendingFrom = api.callsTo('GET', STATUS_PATH).length;
    await elapse(6_000);
    expect(api.callsTo('GET', STATUS_PATH).length - pendingFrom).toBe(3);

    // Published: the gallery is told, and the pace is slow again.
    state = 'completed';
    await elapse(2_000);
    expect(published).toHaveBeenCalledTimes(1);
    const doneAt = api.callsTo('GET', STATUS_PATH).length;
    await elapse(14_000);
    expect(api.callsTo('GET', STATUS_PATH).length).toBe(doneAt);
    window.removeEventListener('emucat:media-published', published);
  });
});
