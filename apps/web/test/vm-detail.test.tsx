import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ExecutionAgentOption, ExecutionOptionsResponse } from '@emucat/contracts';
import { describe, expect, it } from 'vitest';
import {
  adminSession,
  MEDIA_ID,
  mockApi,
  OTHER_MEDIA_ID,
  renderAt,
  signedInAsAdmin,
} from './mock-api';

const PUBLIC_PATH = '/catalog/vms/qemu/Win98';
const OPTIONS_PATH = '/admin/vms/qemu/Win98/execution-options';
const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7001';
const SESSION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7005';
const PAST = '2026-01-01T00:00:00.000Z';

const image = (id: string) => ({ id, widthPx: 640, heightPx: 480 });

const detail = {
  emulatorType: 'qemu',
  vmName: 'Win98',
  displayName: 'Windows 98 SE',
  description: 'A retro machine',
  mainImage: image(OTHER_MEDIA_ID),
  gallery: [image(MEDIA_ID), image(OTHER_MEDIA_ID)],
};

const MODES: ExecutionOptionsResponse['modes'] = [
  { mode: 'local', available: true, reason: null },
  { mode: 'remote_volatile', available: false, reason: 'Not yet.' },
  { mode: 'remote_snapshot', available: false, reason: 'Not yet.' },
];

function agent(overrides: Partial<ExecutionAgentOption> = {}): ExecutionAgentOption {
  return {
    agentId: AGENT_ID,
    agentName: 'Study PC',
    online: true,
    launch: { eligible: true, reason: null, problem: null },
    verify: { eligible: true, reason: null },
    local: {
      present: true,
      contentStatus: 'unverified',
      sourceVersionId: null,
      lastVerifiedAt: null,
    },
    activeSession: null,
    lastSession: null,
    lastVerification: null,
    ...overrides,
  };
}

async function open(routes: Record<string, unknown> = {}) {
  const api = mockApi({ [`GET ${PUBLIC_PATH}`]: detail, ...routes });
  renderAt('/vms/qemu/Win98');
  await screen.findByRole('heading', { level: 1, name: 'Windows 98 SE' });
  return api;
}

const gallery = () =>
  screen.getByRole('heading', { name: 'Screenshots' }).closest('section') as HTMLElement;

describe('the VM page layout', () => {
  it('puts the heading and the Launch action first, then the information, then the gallery', async () => {
    await open();
    const heading = screen.getByRole('heading', { level: 1 });
    const launch = screen.getByRole('link', { name: 'Sign in to launch' });
    const info = screen.getByRole('heading', { name: 'General information' });
    const shots = screen.getByRole('heading', { name: 'Screenshots' });
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(heading, launch)).toBe(true);
    expect(follows(launch, info)).toBe(true);
    expect(follows(info, shots)).toBe(true);
    expect(screen.getByText('QEMU', { selector: '.emulator-badge' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the catalog' }).getAttribute('href')).toBe(
      '/',
    );
  });

  it('shows what the catalog knows about the VM, and nothing invented', async () => {
    await open();
    const info = screen
      .getByRole('heading', { name: 'General information' })
      .closest('section') as HTMLElement;
    const facts = [...info.querySelectorAll('dt')].map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]);
    expect(facts).toEqual([
      ['Emulator', 'QEMU'],
      ['VM name', 'Win98'],
      ['Screenshots', '2'],
    ]);
    expect(within(info).getByText('A retro machine')).toBeTruthy();
    expect(within(info).getByAltText('Screenshot of Windows 98 SE').getAttribute('src')).toBe(
      `/api/v1/catalog/media/${OTHER_MEDIA_ID}/full`,
    );
  });

  it('copes with a VM that has no description, display name or screenshots', async () => {
    mockApi({
      [`GET ${PUBLIC_PATH}`]: {
        ...detail,
        displayName: null,
        description: null,
        mainImage: null,
        gallery: [],
      },
    });
    renderAt('/vms/qemu/Win98');
    await screen.findByRole('heading', { level: 1, name: 'Win98' });
    expect(screen.getByText('No description yet.')).toBeTruthy();
    expect(screen.getByText('None yet')).toBeTruthy();
    expect(screen.getByText('There are no screenshots yet.')).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Screenshot size' })).toBeNull();
  });
});

describe('the Launch action', () => {
  it('asks a visitor to sign in, and comes back to this page', async () => {
    await open();
    const link = screen.getByRole('link', { name: 'Sign in to launch' });
    expect(link.getAttribute('href')).toBe('/login?next=%2Fvms%2Fqemu%2FWin98');
  });

  it('tells a signed-in user who is not an administrator why they cannot launch', async () => {
    await open({ 'GET /auth/session': { session: adminSession({ role: 'user' }) } });
    const button = await screen.findByRole('button', { name: 'Launch VM' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('launch-help');
    expect(screen.getByText('Only administrators can launch VMs.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Manage this VM' })).toBeNull();
  });

  it('opens the launcher over the page for an administrator, and launches from it', async () => {
    const api = await open({
      ...signedInAsAdmin,
      [`GET ${OPTIONS_PATH}`]: { modes: MODES, agents: [agent()] },
      'GET /admin/sessions': { sessions: [] },
      'POST /admin/sessions': {
        id: SESSION_ID,
        agentId: AGENT_ID,
        agentName: 'Study PC',
        agentOnline: true,
        emulatorType: 'qemu',
        vmName: 'Win98',
        mode: 'local',
        state: 'requested',
        versionId: null,
        pid: null,
        processStartedAt: null,
        requestedAt: PAST,
        startedAt: null,
        endedAt: null,
        exitCode: null,
        stopRequested: false,
        forceRequested: false,
        gracefulStopAvailable: false,
        error: null,
        recovery: null,
        requestedByDisplayName: 'Ada Admin',
        updatedAt: PAST,
      },
    });
    expect(screen.getByRole('link', { name: 'Manage this VM' }).getAttribute('href')).toBe(
      '/admin/vms/qemu/Win98',
    );
    // Nothing is polled until the launcher is open.
    expect(api.callsTo('GET', OPTIONS_PATH)).toHaveLength(0);

    const trigger = await screen.findByRole('button', { name: 'Launch VM' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Launch Windows 98 SE' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(api.callsTo('POST', '/admin/sessions')).toHaveLength(1));
    expect(api.callsTo('POST', '/admin/sessions')[0]?.body).toMatchObject({
      agentId: AGENT_ID,
      emulatorType: 'qemu',
      vmName: 'Win98',
      mode: 'local',
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).not.toBe(dialog);
  });

  it('lets Escape close a confirmation inside the launcher without closing the launcher', async () => {
    await open({
      ...signedInAsAdmin,
      [`GET ${OPTIONS_PATH}`]: {
        modes: MODES,
        agents: [
          agent({
            launch: { eligible: false, reason: 'session_active', problem: null },
            activeSession: {
              id: SESSION_ID,
              agentId: AGENT_ID,
              agentName: 'Study PC',
              agentOnline: true,
              emulatorType: 'qemu',
              vmName: 'Win98',
              mode: 'local',
              state: 'running',
              versionId: null,
              pid: 4242,
              processStartedAt: PAST,
              requestedAt: PAST,
              startedAt: PAST,
              endedAt: null,
              exitCode: null,
              stopRequested: false,
              forceRequested: false,
              gracefulStopAvailable: true,
              error: null,
              recovery: null,
              requestedByDisplayName: 'Ada Admin',
              updatedAt: PAST,
            },
          }),
        ],
      },
      'GET /admin/sessions': { sessions: [] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Launch VM' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Force stop…' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    expect(screen.getByRole('dialog', { name: 'Launch Windows 98 SE' })).toBeTruthy();
  });
});

describe('the screenshot gallery', () => {
  it('marks the main cover among the thumbnails', async () => {
    await open();
    const main = within(gallery()).getByRole('button', {
      name: 'View Screenshot of Windows 98 SE at full resolution, the main cover',
    });
    expect(within(main).getByText('Main cover')).toBeTruthy();
    expect(main.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1/catalog/media/${OTHER_MEDIA_ID}/thumbnail`,
    );
    expect(within(gallery()).getAllByText('Main cover')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull();
  });

  it('shows medium cards at first, and remembers the size a viewer chooses', async () => {
    await open();
    const grid = () => gallery().querySelector('.gallery-grid') as HTMLElement;
    const sizes = screen.getByRole('radiogroup', { name: 'Screenshot size' });
    expect(grid().dataset.size).toBe('medium');
    expect((within(sizes).getByRole('radio', { name: 'Medium' }) as HTMLInputElement).checked).toBe(
      true,
    );

    fireEvent.click(within(sizes).getByRole('radio', { name: 'Large' }));
    expect(grid().dataset.size).toBe('large');
    expect(localStorage.getItem('emucat.gallery.cardSize')).toBe('large');
  });

  it('starts from the size remembered in this browser, and never tells the server', async () => {
    localStorage.setItem('emucat.gallery.cardSize', 'small');
    const api = await open();
    expect((gallery().querySelector('.gallery-grid') as HTMLElement).dataset.size).toBe('small');
    // The choice is the viewer's alone: the server never hears of it.
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('falls back to medium for a stored value it does not know', async () => {
    localStorage.setItem('emucat.gallery.cardSize', 'enormous');
    await open();
    expect((gallery().querySelector('.gallery-grid') as HTMLElement).dataset.size).toBe('medium');
  });

  it('opens the cover and the thumbnails in the same viewer, across the whole gallery', async () => {
    await open();
    fireEvent.click(
      screen.getByRole('button', { name: 'View the main screenshot at full resolution' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/2 of 2/)).toBeTruthy();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1/catalog/media/${MEDIA_ID}/full`,
    );
  });
});
