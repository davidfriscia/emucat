import type { AgentSummary, DiscoveryOperation, PairingRequestReview } from '@emucat/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockApi, renderAt, resetApiState, signedInAsAdmin } from './mock-api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  resetApiState();
});

const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f63';
const REQUEST_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f64';
const OPERATION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f65';
const AGENT_PATH = `/admin/agents/${AGENT_ID}`;
const WHEN = '2026-01-31T15:30:00.000Z';

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: AGENT_ID,
    name: 'Desk PC',
    platform: 'windows',
    architecture: 'x86_64',
    agentVersion: '0.2.0',
    protocolVersion: 1,
    pairingStatus: 'paired',
    online: true,
    ownerDisplayName: 'Ada Admin',
    pairedAt: WHEN,
    lastConnectedAt: WHEN,
    lastSeenAt: WHEN,
    revokedAt: null,
    ...overrides,
  };
}

function pairingRequest(overrides: Partial<PairingRequestReview> = {}): PairingRequestReview {
  return {
    id: REQUEST_ID,
    status: 'pending',
    name: 'Attic server',
    platform: 'linux',
    architecture: 'aarch64',
    agentVersion: '0.1.0',
    protocolVersion: 1,
    requestedFrom: '192.0.2.7',
    createdAt: WHEN,
    expiresAt: WHEN,
    agentId: null,
    ...overrides,
  };
}

function operation(overrides: Partial<DiscoveryOperation> = {}): DiscoveryOperation {
  return {
    id: OPERATION_ID,
    agentId: AGENT_ID,
    status: 'completed',
    startedAt: WHEN,
    finishedAt: WHEN,
    failure: null,
    hostPlatform: 'windows',
    emulators: [
      { emulatorType: '86box', status: 'ok', truncated: false },
      { emulatorType: 'qemu', status: 'ok', truncated: false },
    ],
    vms: [
      {
        emulatorType: '86box',
        vmName: 'Dos622',
        markers: ['86box.cfg'],
        hostCompatible: null,
        registered: false,
      },
      {
        emulatorType: 'qemu',
        vmName: 'Win98',
        markers: ['run-win.cmd'],
        hostCompatible: true,
        registered: true,
      },
      {
        emulatorType: 'qemu',
        vmName: 'Tux',
        markers: ['run-linux.sh'],
        hostCompatible: false,
        registered: false,
      },
    ],
    skipped: [
      { emulatorType: 'qemu', name: 'bad.', reason: 'invalid_name', nameError: 'invalid_boundary' },
      { emulatorType: '86box', name: 'Linked', reason: 'reparse_point', nameError: null },
    ],
    ...overrides,
  };
}

const LIST_ROUTES = {
  'GET /admin/agents': { agents: [] as AgentSummary[] },
  'GET /admin/agent-pairing/requests': { requests: [] as PairingRequestReview[] },
};

const articleOf = (element: HTMLElement) => element.closest('article') as HTMLElement;

describe('navigation', () => {
  it('offers Agents to an administrator', async () => {
    mockApi({ ...signedInAsAdmin, ...LIST_ROUTES });
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'Agents' })).toBeTruthy();
  });

  it('does not offer Agents to anyone else', async () => {
    mockApi();
    renderAt('/');
    await screen.findByRole('link', { name: 'Sign in' });
    expect(screen.queryByRole('link', { name: 'Agents' })).toBeNull();
  });

  it('sends an anonymous visitor to sign in', async () => {
    mockApi();
    renderAt('/admin/agents');
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toContain('/login?next='),
    );
  });
});

describe('agents list', () => {
  it('has an empty state', async () => {
    mockApi({ ...signedInAsAdmin, ...LIST_ROUTES });
    renderAt('/admin/agents');
    expect(await screen.findByRole('heading', { name: 'No agents yet' })).toBeTruthy();
  });

  it('shows each agent’s details and status', async () => {
    mockApi({
      ...signedInAsAdmin,
      ...LIST_ROUTES,
      'GET /admin/agents': {
        agents: [
          agent(),
          agent({
            id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f70',
            name: 'Old laptop',
            online: false,
            pairingStatus: 'revoked',
            revokedAt: WHEN,
            platform: 'linux',
            lastSeenAt: null,
          }),
        ],
      },
    });
    renderAt('/admin/agents');
    const desk = articleOf(await screen.findByRole('link', { name: 'Desk PC' }));
    expect(within(desk).getByText('Online')).toBeTruthy();
    expect(within(desk).getByText('Paired')).toBeTruthy();
    expect(within(desk).getByText('Windows, x86_64')).toBeTruthy();
    expect(within(desk).getByText('0.2.0')).toBeTruthy();
    expect(within(desk).getByText(new Date(WHEN).toLocaleString())).toBeTruthy();

    const laptop = articleOf(screen.getByRole('link', { name: 'Old laptop' }));
    expect(within(laptop).getByText('Offline')).toBeTruthy();
    expect(within(laptop).getByText('Revoked')).toBeTruthy();
    expect(within(laptop).getByText('Never')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Desk PC' }).getAttribute('href')).toBe(AGENT_PATH);
  });

  it('reports a failure to load, and can retry', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      ...LIST_ROUTES,
      'GET /admin/agents': apiError(500, 'internal_error', 'Internal error'),
    });
    renderAt('/admin/agents');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(api.callsTo('GET', '/admin/agents').length).toBeGreaterThan(0);
  });

  it('keeps showing what it has when the server goes away, and recovers', async () => {
    let available = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi({
        ...signedInAsAdmin,
        ...LIST_ROUTES,
        'GET /admin/agents': () => {
          if (!available) throw new TypeError('Failed to fetch');
          return { agents: [agent()] };
        },
      });
      renderAt('/admin/agents');
      await screen.findByRole('link', { name: 'Desk PC' });

      available = false;
      await vi.advanceTimersByTimeAsync(5_100);
      expect(await screen.findByText(/cannot be reached right now/)).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Desk PC' })).toBeTruthy();

      available = true;
      await vi.advanceTimersByTimeAsync(5_100);
      await waitFor(() => expect(screen.queryByText(/cannot be reached right now/)).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pairing', () => {
  const enterCode = async (code = 'abcd-2345') => {
    fireEvent.change(await screen.findByLabelText('Pairing code'), { target: { value: code } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  };

  it('accepts a review only for something that can be a code', async () => {
    mockApi({ ...signedInAsAdmin, ...LIST_ROUTES });
    renderAt('/admin/agents');
    const input = await screen.findByLabelText('Pairing code');
    const review = screen.getByRole('button', { name: 'Review' }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'short' } });
    expect(review.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'abcd 2345' } });
    expect(review.disabled).toBe(false);
    expect(screen.getByText('Will look up ABCD-2345.')).toBeTruthy();
  });

  it('shows who is asking before anything can be approved', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      ...LIST_ROUTES,
      'POST /admin/agent-pairing/lookup': pairingRequest(),
    });
    renderAt('/admin/agents');
    await enterCode();
    expect(await screen.findByText('Is this the agent you are pairing?')).toBeTruthy();
    expect(screen.getByText('Attic server')).toBeTruthy();
    expect(screen.getByText('Linux, aarch64')).toBeTruthy();
    expect(screen.getByText('192.0.2.7')).toBeTruthy();
    expect(api.callsTo('POST', '/admin/agent-pairing/lookup')[0]?.body).toEqual({
      code: 'abcd-2345',
    });
    expect(api.callsTo('POST', `/admin/agent-pairing/requests/${REQUEST_ID}/approve`)).toEqual([]);
  });

  it('approves with the code and the CSRF token, then follows the agent collecting', async () => {
    let collected = false;
    const api = mockApi({
      ...signedInAsAdmin,
      ...LIST_ROUTES,
      'POST /admin/agent-pairing/lookup': pairingRequest(),
      [`POST /admin/agent-pairing/requests/${REQUEST_ID}/approve`]: () => {
        return pairingRequest({ status: 'approved' });
      },
      [`GET /admin/agent-pairing/requests/${REQUEST_ID}`]: () =>
        collected
          ? pairingRequest({ status: 'completed', agentId: AGENT_ID })
          : pairingRequest({ status: 'approved' }),
    });
    renderAt('/admin/agents');
    await enterCode();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText(/Waiting for/)).toBeTruthy();
    const [call] = api.callsTo('POST', `/admin/agent-pairing/requests/${REQUEST_ID}/approve`);
    expect(call?.body).toEqual({ code: 'abcd-2345' });
    expect(call?.headers['x-csrf-token']).toBe('test-csrf-token');

    collected = true;
    expect(await screen.findByText(/is paired/, {}, { timeout: 4_000 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View this agent' }).getAttribute('href')).toBe(
      AGENT_PATH,
    );
  });

  it('reports when the agent never collects its credential', async () => {
    mockApi({
      ...signedInAsAdmin,
      ...LIST_ROUTES,
      'POST /admin/agent-pairing/lookup': pairingRequest(),
      [`POST /admin/agent-pairing/requests/${REQUEST_ID}/approve`]: pairingRequest({
        status: 'approved',
      }),
      [`GET /admin/agent-pairing/requests/${REQUEST_ID}`]: pairingRequest({ status: 'expired' }),
    });
    renderAt('/admin/agents');
    await enterCode();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/did not collect its credential/)).toBeTruthy();
  });

  it('can reject', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      ...LIST_ROUTES,
      'POST /admin/agent-pairing/lookup': pairingRequest(),
      [`POST /admin/agent-pairing/requests/${REQUEST_ID}/reject`]: pairingRequest({
        status: 'rejected',
      }),
    });
    renderAt('/admin/agents');
    await enterCode();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(await screen.findByText(/was rejected/)).toBeTruthy();
    expect(
      api.callsTo('POST', `/admin/agent-pairing/requests/${REQUEST_ID}/reject`)[0]?.headers[
        'x-csrf-token'
      ],
    ).toBe('test-csrf-token');
  });

  it('can cancel the review, approving nothing', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      ...LIST_ROUTES,
      'POST /admin/agent-pairing/lookup': pairingRequest(),
    });
    renderAt('/admin/agents');
    await enterCode();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByLabelText('Pairing code')).toBeTruthy();
    expect(api.callsTo('POST', `/admin/agent-pairing/requests/${REQUEST_ID}/approve`)).toEqual([]);
  });

  it.each([
    [404, 'pairing_code_invalid', 'That pairing code is not valid. Check it and retry.'],
    [410, 'pairing_expired', 'This pairing request has expired. Start pairing again.'],
    [429, 'rate_limited', 'Too many attempts. Try again later.'],
  ])('explains a %i %s', async (status, code, message) => {
    mockApi({
      ...signedInAsAdmin,
      ...LIST_ROUTES,
      'POST /admin/agent-pairing/lookup': apiError(status, code, message),
    });
    renderAt('/admin/agents');
    await enterCode();
    expect((await screen.findByRole('alert')).textContent).toContain(message);
  });

  it('returns to the form when a request expires during review', async () => {
    mockApi({
      ...signedInAsAdmin,
      ...LIST_ROUTES,
      'POST /admin/agent-pairing/lookup': pairingRequest(),
      [`POST /admin/agent-pairing/requests/${REQUEST_ID}/approve`]: apiError(
        410,
        'pairing_expired',
        'This pairing request has expired. Start pairing again.',
      ),
    });
    renderAt('/admin/agents');
    await enterCode();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toContain('expired');
    expect(screen.getByLabelText('Pairing code')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('reports an unreachable server', async () => {
    mockApi({ ...signedInAsAdmin, ...LIST_ROUTES });
    renderAt('/admin/agents');
    await enterCode();
    expect((await screen.findByRole('alert')).textContent).toContain('could not be reached');
  });

  it('lists waiting requests, which can be rejected but not approved without the code', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      ...LIST_ROUTES,
      'GET /admin/agent-pairing/requests': { requests: [pairingRequest()] },
      [`POST /admin/agent-pairing/requests/${REQUEST_ID}/reject`]: pairingRequest({
        status: 'rejected',
      }),
    });
    renderAt('/admin/agents');
    const card = articleOf(await screen.findByRole('heading', { name: 'Attic server' }));
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(
        api.callsTo('POST', `/admin/agent-pairing/requests/${REQUEST_ID}/reject`),
      ).toHaveLength(1),
    );
  });
});

describe('agent details', () => {
  const noOperation = { operation: null };

  it('says when an agent does not exist', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: apiError(404, 'agent_not_found', 'Agent not found'),
    });
    renderAt(AGENT_PATH);
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeTruthy();
  });

  it('asks for confirmation before revoking, explains the effect, and does it', async () => {
    let revoked = false;
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: () =>
        revoked ? agent({ online: false, pairingStatus: 'revoked', revokedAt: WHEN }) : agent(),
      [`GET ${AGENT_PATH}/discovery`]: noOperation,
      [`POST ${AGENT_PATH}/revoke`]: () => {
        revoked = true;
        return agent({ online: false, pairingStatus: 'revoked', revokedAt: WHEN });
      },
    });
    renderAt(AGENT_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(api.callsTo('POST', `${AGENT_PATH}/revoke`)).toEqual([]);
    expect(screen.getByText(/VM files are not touched/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm revocation' }));
    expect(await screen.findByText(/emucat-agent pair --force/)).toBeTruthy();
    expect(screen.getByText('Revoked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Discover virtual machines' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(api.callsTo('POST', `${AGENT_PATH}/revoke`)[0]?.headers['x-csrf-token']).toBe(
      'test-csrf-token',
    );
  });

  it('can back out of revoking', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent(),
      [`GET ${AGENT_PATH}/discovery`]: noOperation,
    });
    renderAt(AGENT_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep this agent' }));
    expect(await screen.findByRole('button', { name: 'Revoke' })).toBeTruthy();
    expect(api.callsTo('POST', `${AGENT_PATH}/revoke`)).toEqual([]);
  });
});

describe('discovery', () => {
  const finished = { operation: operation() };

  it('is unavailable while the agent is offline, and says so', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent({ online: false }),
      [`GET ${AGENT_PATH}/discovery`]: { operation: null },
    });
    renderAt(AGENT_PATH);
    expect(await screen.findByText(/offline. Discovery works once it reconnects/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Discover virtual machines' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('shows progress, then the results', async () => {
    let done = false;
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent(),
      [`GET ${AGENT_PATH}/discovery`]: () =>
        done
          ? finished
          : {
              operation: operation({
                status: 'running',
                finishedAt: null,
                vms: [],
                skipped: [],
                emulators: [],
              }),
            },
      [`POST ${AGENT_PATH}/discovery`]: () =>
        operation({ status: 'running', finishedAt: null, vms: [], skipped: [], emulators: [] }),
    });
    renderAt(AGENT_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Discover virtual machines' }));
    expect(await screen.findByText(/The agent is scanning/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Discovering…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.callsTo('POST', `${AGENT_PATH}/discovery`)[0]?.headers['x-csrf-token']).toBe(
      'test-csrf-token',
    );

    done = true;
    expect(await screen.findByRole('heading', { name: 'Dos622' }, { timeout: 4_000 })).toBeTruthy();
  });

  it('lists VMs with their emulator, registration and host compatibility', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent(),
      [`GET ${AGENT_PATH}/discovery`]: finished,
    });
    renderAt(AGENT_PATH);
    const box = articleOf(await screen.findByRole('heading', { name: 'Dos622' }));
    expect(within(box).getByText('86Box')).toBeTruthy();
    expect(within(box).getByText('Not registered')).toBeTruthy();
    expect(within(box).queryByText(/launch script/)).toBeNull();

    const registered = articleOf(screen.getByRole('heading', { name: 'Win98' }));
    expect(within(registered).getByText('QEMU')).toBeTruthy();
    expect(within(registered).getByText('Already registered')).toBeTruthy();
    expect(within(registered).getByText('Has a launch script for this host')).toBeTruthy();

    const foreign = articleOf(screen.getByRole('heading', { name: 'Tux' }));
    expect(within(foreign).getByText('No launch script for this host')).toBeTruthy();
  });

  it('explains skipped directories', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent(),
      [`GET ${AGENT_PATH}/discovery`]: finished,
    });
    renderAt(AGENT_PATH);
    expect(await screen.findByText('bad.')).toBeTruthy();
    expect(screen.getByText(/not a valid VM name: it must start and end/)).toBeTruthy();
    expect(screen.getByText(/never followed/)).toBeTruthy();
  });

  it('offers no way to register yet, and does not suggest the VMs are in the catalog', async () => {
    const api = mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent(),
      [`GET ${AGENT_PATH}/discovery`]: finished,
    });
    renderAt(AGENT_PATH);
    await screen.findByRole('heading', { name: 'Dos622' });
    const buttons = screen.getAllByRole('button', { name: /Register/ }) as HTMLButtonElement[];
    expect(buttons.length).toBe(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain('Milestone 3');
      fireEvent.click(button);
    }
    expect(screen.getByRole('note').textContent).toMatch(/observations, not catalog entries/);
    expect(api.calls.filter((call) => call.method !== 'GET' && call.path.includes('/vms'))).toEqual(
      [],
    );
  });

  it('has an empty state', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent(),
      [`GET ${AGENT_PATH}/discovery`]: { operation: operation({ vms: [], skipped: [] }) },
    });
    renderAt(AGENT_PATH);
    expect(await screen.findByRole('heading', { name: 'No virtual machines found' })).toBeTruthy();
  });

  it('reports what happened to each emulator', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent(),
      [`GET ${AGENT_PATH}/discovery`]: {
        operation: operation({
          vms: [],
          skipped: [],
          emulators: [
            { emulatorType: '86box', status: 'base_path_missing', truncated: false },
            { emulatorType: 'qemu', status: 'not_configured', truncated: false },
          ],
        }),
      },
    });
    renderAt(AGENT_PATH);
    expect(await screen.findByText(/configured directory does not exist/)).toBeTruthy();
    expect(screen.getByText(/Not configured on this agent/)).toBeTruthy();
  });

  it('warns when a report is incomplete', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent(),
      [`GET ${AGENT_PATH}/discovery`]: {
        operation: operation({
          emulators: [{ emulatorType: 'qemu', status: 'ok', truncated: true }],
        }),
      },
    });
    renderAt(AGENT_PATH);
    expect(await screen.findByText(/This report is incomplete/)).toBeTruthy();
  });

  it.each([
    ['timeout', 'The agent did not answer in time.'],
    ['agent_disconnected', 'The agent disconnected before it finished.'],
    ['agent_revoked', 'The agent was revoked.'],
  ] as const)('reports a failed scan: %s', async (code, message) => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent(),
      [`GET ${AGENT_PATH}/discovery`]: {
        operation: operation({
          status: 'failed',
          failure: { code, message },
          vms: [],
          skipped: [],
          emulators: [],
        }),
      },
    });
    renderAt(AGENT_PATH);
    expect(await screen.findByText(new RegExp(message))).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Discover virtual machines' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('reports a refusal, such as the agent having just gone offline', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${AGENT_PATH}`]: agent(),
      [`GET ${AGENT_PATH}/discovery`]: { operation: null },
      [`POST ${AGENT_PATH}/discovery`]: apiError(409, 'agent_offline', 'This agent is offline.'),
    });
    renderAt(AGENT_PATH);
    fireEvent.click(await screen.findByRole('button', { name: 'Discover virtual machines' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This agent is offline.');
  });
});
