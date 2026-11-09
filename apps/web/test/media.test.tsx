import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminMedia,
  MEDIA_ID,
  mockApi,
  OTHER_MEDIA_ID,
  renderAt,
  resetApiState,
  signedInAsAdmin,
} from './mock-api';

const VM_PATH = '/admin/vms/qemu/Win98';
const MEDIA_PATH = `${VM_PATH}/media`;
const SYNC_PATH = `${VM_PATH}/media-sync`;
const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f80';

const items = [
  adminMedia({
    originalFilename: 'screenshots/nested/boot.png',
    createdAt: '2026-03-04T05:06:07.000Z',
  }),
  adminMedia({ id: OTHER_MEDIA_ID, originalFilename: 'desktop.png', isMain: true }),
];

function status(overrides: object = {}) {
  return {
    agents: [
      {
        agentId: AGENT_ID,
        agentName: 'Desk PC',
        online: true,
        status: {
          pending: 2,
          uploading: 1,
          synchronized: 9,
          failed: 0,
          lastError: null,
          reportedAt: '2026-03-04T05:06:07.000Z',
          ...overrides,
        },
      },
    ],
  };
}

beforeEach(() => resetApiState());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

describe('the screenshot gallery', () => {
  it('opens the full image from a thumbnail, and closes it with Escape, returning focus', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: items },
      [`GET ${SYNC_PATH}`]: status(),
    });
    renderAt(MEDIA_PATH);
    const open = await screen.findByRole('button', {
      name: 'View screenshots/nested/boot.png at full resolution',
    });
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1${VM_PATH}/media/${MEDIA_ID}/full`,
    );
    const download = within(dialog).getByRole('link', { name: 'Download original' });
    expect(download.getAttribute('href')).toBe(`/api/v1${VM_PATH}/media/${MEDIA_ID}/original`);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it('shows what an administrator needs to know about each image', async () => {
    mockApi({ ...signedInAsAdmin, [`GET ${MEDIA_PATH}`]: { media: items } });
    renderAt(MEDIA_PATH);
    const heading = await screen.findByRole('heading', { name: 'screenshots/nested/boot.png' });
    const card = heading.closest('article') as HTMLElement;
    expect(within(card).queryByText('Private')).toBeNull();
    expect(within(card).queryByText('Published')).toBeNull();
    expect(within(card).getByText(/640 × 480/)).toBeTruthy();
    expect(within(card).getByText(/Uploaded/)).toBeTruthy();
    const main = screen.getByRole('heading', { name: 'desktop.png' }).closest('article');
    expect(within(main as HTMLElement).getByText('Main image')).toBeTruthy();
  });

  it('explains that screenshots follow the VM’s visibility', async () => {
    mockApi({ ...signedInAsAdmin, [`GET ${MEDIA_PATH}`]: { media: items } });
    renderAt(MEDIA_PATH);
    expect(await screen.findByText(/They have no visibility of their own/)).toBeTruthy();
  });

  it('never reveals a storage location, because it is never given one', async () => {
    mockApi({ ...signedInAsAdmin, [`GET ${MEDIA_PATH}`]: { media: items } });
    renderAt(MEDIA_PATH);
    await screen.findByRole('heading', { name: 'desktop.png' });
    expect(document.body.innerHTML).not.toMatch(/media\/(originals|full|thumbnails)\//);
  });
});

describe('the synchronization summary', () => {
  it('shows what the agent reported', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: items },
      [`GET ${SYNC_PATH}`]: status(),
    });
    renderAt(MEDIA_PATH);
    const summary = await screen.findByRole('region', { name: 'Screenshot synchronization' });
    expect(within(summary).getByText('Desk PC')).toBeTruthy();
    expect(within(summary).getByText('Online')).toBeTruthy();
    for (const label of ['Pending', 'Uploading', 'Synchronized', 'Failed']) {
      expect(within(summary).getByText(label)).toBeTruthy();
    }
    expect(within(summary).getByText('9')).toBeTruthy();
  });

  it('says which file failed and why', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: [] },
      [`GET ${SYNC_PATH}`]: status({
        failed: 1,
        lastError: {
          code: 'invalid_image',
          message: 'The image could not be decoded',
          sourcePath: 'screenshots/bad.png',
        },
      }),
    });
    renderAt(MEDIA_PATH);
    expect(
      await screen.findByText('screenshots/bad.png: The image could not be decoded'),
    ).toBeTruthy();
  });

  it('copes with an offline agent, no report and no agent', async () => {
    mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: [] },
      [`GET ${SYNC_PATH}`]: {
        agents: [{ agentId: AGENT_ID, agentName: 'Desk PC', online: false, status: null }],
      },
    });
    const first = renderAt(MEDIA_PATH);
    expect(await screen.findByText('Offline')).toBeTruthy();
    expect(screen.getByText(/has not reported/)).toBeTruthy();
    first.unmount();

    mockApi({
      ...signedInAsAdmin,
      [`GET ${MEDIA_PATH}`]: { media: [] },
      [`GET ${SYNC_PATH}`]: { agents: [] },
    });
    renderAt(MEDIA_PATH);
    expect(await screen.findByText(/No agent holds this VM/)).toBeTruthy();
  });

  it('does not take the gallery down with it when it cannot be loaded', async () => {
    mockApi({ ...signedInAsAdmin, [`GET ${MEDIA_PATH}`]: { media: items } });
    renderAt(MEDIA_PATH);
    expect(await screen.findByRole('heading', { name: 'desktop.png' })).toBeTruthy();
    expect(await screen.findByText(/status is not available/)).toBeTruthy();
  });
});

describe('a removal blocked by a screenshot', () => {
  it('can be retried from where the registration is shown', async () => {
    const { registrationOperation } = await import('./registration-fixture');
    const operation = registrationOperation();
    const { calls } = mockApi({
      ...signedInAsAdmin,
      [`POST /admin/registrations/${operation.id}/retry-cleanup`]: operation,
    });
    const { RegistrationCard } = await import('../src/components/Registration');
    const { render } = await import('@testing-library/react');
    const { MemoryRouter } = await import('react-router');
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <RegistrationCard operation={operation} onChanged={onChanged} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toContain('capture.ppm');
    fireEvent.click(screen.getByRole('button', { name: 'Retry removal' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls.some((call) => call.path.endsWith('/retry-cleanup'))).toBe(true);
  });
});
