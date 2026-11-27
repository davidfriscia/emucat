/**
 * Operation visibility and the General page (decision 0060) in a real browser: the production build of the whole
 * application, served as nginx serves it, against a stand-in for the API whose operations listing a test sets. It
 * proves what jsdom cannot: the spinner really turns (and slowly where less motion is asked for), indicators fit the
 * card's toolbar row, panels stay inside the window, nothing scrolls sideways on a phone, both themes, and that
 * looking at operations only ever reads.
 *
 * Run with `pnpm --filter @emucat/web test:browser`. Screenshots go to `EMUCAT_BROWSER_SCREENSHOTS` when set.
 * `EMUCAT_BROWSER_CAPTURE_ONLY=1` runs only the capture of General, for a before-and-after comparison against an
 * older build (see the report of decision 0060).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RegistrationOperation, VmOperationListResponse } from '@emucat/contracts';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type HarnessServer, type RecordedRequest } from './server';
import {
  adminVm,
  AGENT_ID,
  AGENT_NAME,
  MASTER,
  remasterPreview,
  restoreOptions,
  SESSION,
  SNAP_A,
  tree,
  VM,
  VM_PATH,
} from './version-history-fixtures';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const DIST = process.env.EMUCAT_BROWSER_DIST ?? join(WEB, 'e2e', 'dist-app');
const SHOTS = process.env.EMUCAT_BROWSER_SCREENSHOTS ?? null;
const PREFIX = process.env.EMUCAT_BROWSER_SCREENSHOT_PREFIX ?? 'operations';
const CAPTURE_ONLY = process.env.EMUCAT_BROWSER_CAPTURE_ONLY === '1';

let server: HarnessServer;
let browser: Browser;
let operations: RegistrationOperation[] = [];
let listingFails = false;
const consoleErrors: string[] = [];

const OPERATION_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9101';
const CLONE_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9102';
const SECOND_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9103';
const REPOSITORY_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9030';

function snapshot(overrides: Partial<RegistrationOperation> = {}): RegistrationOperation {
  const now = new Date().toISOString();
  return {
    id: OPERATION_ID,
    agentId: AGENT_ID,
    agentName: AGENT_NAME,
    agentOnline: true,
    performedBy: 'agent',
    repositoryId: REPOSITORY_ID,
    repositoryName: 'My Storage',
    emulatorType: VM.emulatorType,
    vmName: VM.vmName,
    mode: 'snapshot',
    state: 'uploading',
    versionId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9111',
    parentVersionId: MASTER,
    snapshotName: 'DOS622_202611271430',
    workspaceId: null,
    archiveKey: 'archives/86box/dos622/018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9111.zip',
    progress: { doneBytes: 168_000_000, totalBytes: 270_637_465 },
    archive: null,
    virtualboxUuid: null,
    localCopy: null,
    error: null,
    recovery: null,
    cancelRequested: false,
    requestedByDisplayName: 'Ada Admin',
    createdAt: new Date(Date.now() - 95_000).toISOString(),
    updatedAt: now,
    committedAt: null,
    finishedAt: null,
    acknowledgedAt: null,
    acknowledgedByDisplayName: null,
    parentSnapshotName: null,
    versionDeletion: null,
    cloneSource: null,
    ...overrides,
  };
}

function clone(overrides: Partial<RegistrationOperation> = {}): RegistrationOperation {
  return snapshot({
    id: CLONE_ID,
    mode: 'clone',
    vmName: 'DOS622_Office',
    agentId: null,
    agentName: null,
    agentOnline: false,
    performedBy: 'server',
    state: 'archiving',
    parentVersionId: null,
    snapshotName: null,
    versionId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e9112',
    progress: { doneBytes: 40_000_000, totalBytes: 270_637_465 },
    cloneSource: { vmName: VM.vmName, versionId: SNAP_A },
    ...overrides,
  });
}

function listing(): VmOperationListResponse {
  return {
    operations: operations.map((operation) => ({
      relation: operation.mode === 'clone' ? 'clone_source' : 'this_vm',
      operation,
      transport: operation.performedBy === 'server' ? 'server' : 'sftp',
    })),
    retentionHours: 24,
    serverTime: new Date().toISOString(),
  };
}

async function launch(): Promise<Browser> {
  const executablePath = process.env.EMUCAT_BROWSER_PATH;
  if (executablePath) return chromium.launch({ executablePath, headless: true });
  return chromium
    .launch({ channel: 'msedge', headless: true })
    .catch(() => chromium.launch({ channel: 'chrome', headless: true }));
}

function answer(key: string, body: (request: RecordedRequest) => unknown) {
  server.routes.set(key, body);
}

async function open(
  path: string,
  options: {
    theme?: 'light' | 'dark';
    width?: number;
    height?: number;
    reducedMotion?: boolean;
  } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 1000 },
    deviceScaleFactor: SHOTS ? 2 : 1,
    colorScheme: options.theme ?? 'light',
    reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference',
  });
  await context.addInitScript((theme) => {
    try {
      localStorage.setItem('emucat.theme', theme);
    } catch {
      // The colour scheme of the context then applies.
    }
  }, options.theme ?? 'light');
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push(`${message.text()} ${message.location().url}`);
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(`${server.url}${path}`);
  return page;
}

async function shot(page: Page, name: string, fullPage = false) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${PREFIX}-${name}.png`), fullPage });
}

const card = (page: Page, id: string) =>
  page.locator(`li[aria-labelledby="version-${id}"] > .version-card`);

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

beforeAll(async () => {
  if (!process.env.EMUCAT_BROWSER_DIST) {
    execFileSync(
      'npx',
      ['vite', 'build', '--outDir', 'e2e/dist-app', '--emptyOutDir', '--logLevel', 'warn'],
      { cwd: WEB, stdio: 'inherit' },
    );
  }
  server = await startServer(DIST, { fallback: 'index.html' });
  answer('GET /ready', () => ({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } }));
  answer('GET /auth/session', () => SESSION);
  answer('GET /setup/status', () => ({ setupRequired: false }));
  answer(`GET ${VM_PATH}`, () => adminVm('branches'));
  answer(`GET ${VM_PATH}/versions`, () => tree('branches'));
  answer(`GET ${VM_PATH}/workspaces`, () => ({ workspaces: [] }));
  answer(`GET ${VM_PATH}/restore-options`, () => restoreOptions('branches'));
  answer(`GET ${VM_PATH}/remasters`, () => ({ remasters: [] }));
  answer(`GET ${VM_PATH}/remaster/local`, () => remasterPreview('branches'));
  answer(`GET ${VM_PATH}/media`, () => ({ media: [] }));
  answer('GET /admin/restores', () => ({ operations: [] }));
  answer('GET /admin/local-copy-removals', () => ({ removals: [] }));
  answer('GET /admin/sessions', () => ({ sessions: [] }));
  answer('GET /admin/tags', () => ({ tags: [] }));
  answer(`GET ${VM_PATH}/execution-options`, () => ({
    modes: [
      { mode: 'local', available: true, reason: null },
      { mode: 'remote_volatile', available: true, reason: null },
      { mode: 'remote_snapshot', available: true, reason: null },
    ],
    agents: [
      {
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        online: true,
        launch: { eligible: true, reason: null, problem: null },
        verify: { eligible: true, reason: null },
        remote: {
          remote_volatile: { eligible: true, reason: null, problem: null },
          remote_snapshot: { eligible: true, reason: null, problem: null },
        },
        activeWorkspaceId: null,
        local: {
          present: true,
          contentStatus: 'unverified',
          sourceVersionId: MASTER,
          lastVerifiedAt: null,
        },
        activeSession: null,
        lastSession: null,
        lastVerification: null,
      },
    ],
  }));
  answer(`GET ${VM_PATH}/operations`, () =>
    listingFails
      ? Response.json(
          { error: { code: 'unavailable', message: 'Service unavailable', requestId: 'h' } },
          { status: 503 },
        )
      : listing(),
  );
  browser = await launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('General, captured for comparison', () => {
  it('captures General at the same sizes, whatever the design', async () => {
    operations = [];
    for (const [name, options] of [
      ['general-wide-light', {}],
      ['general-wide-dark', { theme: 'dark' }],
      ['general-narrow', { width: 390, height: 844 }],
    ] as const) {
      const page = await open(VM_PATH, options);
      await page.getByRole('heading', { name: 'Run and verify' }).waitFor();
      await page.locator('#execution-agent').waitFor();
      await shot(page, name);
      await shot(page, `${name}-full`, true);
      await page.context().close();
    }
  });
});

describe.skipIf(CAPTURE_ONLY)('operations in Version History', () => {
  it('draws a turning indicator on the version each operation concerns, within the card’s one toolbar row', async () => {
    operations = [snapshot(), clone()];
    const page = await open(`${VM_PATH}/versions`);
    const syncing = card(page, MASTER).getByRole('button', {
      name: 'Creating snapshot of Master: Transferring 62%',
    });
    await syncing.waitFor();
    const spinner = syncing.locator('svg.icon-spin');
    expect(await spinner.evaluate((node) => getComputedStyle(node).animationName)).toBe(
      'icon-spin',
    );
    expect(await spinner.evaluate((node) => getComputedStyle(node).animationDuration)).toBe('1s');
    const cloning = card(page, SNAP_A).getByRole('button', {
      name: 'Cloning VM of DOS622_202611182136: Copying the source archive 14%',
    });
    await cloning.waitFor();
    for (const id of [MASTER, SNAP_A]) {
      const rows = await card(page, id)
        .getByRole('toolbar')
        .evaluate(
          (toolbar) =>
            new Set(
              [...toolbar.querySelectorAll('button')].map((button) =>
                Math.round(button.getBoundingClientRect().top),
              ),
            ).size,
        );
      expect(rows).toBe(1);
    }
    // The page's own indicator counts both.
    await page
      .getByRole('button', { name: 'Operations of this VM: 2 operations running' })
      .waitFor();
    await shot(page, 'vh-active-light');

    await syncing.click();
    const panel = page.getByRole('dialog', { name: 'Creating snapshot' });
    await panel.waitFor();
    const text = await panel.innerText();
    for (const fact of [
      OPERATION_ID,
      'Snapshot of a local copy',
      'Transferring: 160.2 MiB of 258.1 MiB (62%).',
      `${AGENT_NAME} (online)`,
      'Direct SFTP from the agent, as in its latest repository check',
      'exists only once published',
    ]) {
      expect(text).toContain(fact);
    }
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
    await shot(page, 'vh-details');
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    expect(await syncing.evaluate((node) => node === document.activeElement)).toBe(true);
    // Looking at operations only ever reads.
    expect(server.requests.some((request) => request.method !== 'GET')).toBe(false);
    await page.context().close();
  });

  it('turns slowly where less motion is asked for, and fits a phone without sideways scrolling', async () => {
    operations = [
      snapshot(),
      clone(),
      snapshot({ id: SECOND_ID, state: 'queued', progress: { doneBytes: null, totalBytes: null } }),
    ];
    const page = await open(`${VM_PATH}/versions`, {
      width: 390,
      height: 844,
      reducedMotion: true,
    });
    const several = card(page, MASTER).getByRole('button', {
      name: 'Operations of Master: 2 of 2 operations running',
    });
    await several.waitFor();
    expect(
      await several
        .locator('svg.icon-spin')
        .evaluate((node) => getComputedStyle(node).animationDuration),
    ).toBe('3s');
    expect(await noSidewaysScroll(page)).toBe(true);
    await shot(page, 'vh-multiple-narrow');
    await several.click();
    const panel = page.getByRole('dialog', { name: 'Operations of Master' });
    await panel.waitFor();
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await shot(page, 'vh-multiple-narrow-details');
    await page.context().close();
  });

  it('shows a dark theme with the same contrast rules', async () => {
    operations = [snapshot(), clone()];
    const page = await open(`${VM_PATH}/versions`, { theme: 'dark' });
    const syncing = card(page, MASTER).getByRole('button', {
      name: /^Creating snapshot of Master/,
    });
    await syncing.waitFor();
    // Bootstrap's emphasis colours for the dark theme: light text, never the light theme's dark one.
    const color = await syncing.evaluate((node) => getComputedStyle(node).color);
    const [r, g, b] = (color.match(/\d+/g) ?? []).map(Number);
    expect((r! + g! + b!) / 3).toBeGreaterThan(120);
    await shot(page, 'vh-active-dark');
    await page.context().close();
  });

  it('ends with an explicit notice, and the tree read again', async () => {
    operations = [snapshot()];
    const page = await open(`${VM_PATH}/versions`);
    await card(page, MASTER)
      .getByRole('button', { name: /^Creating snapshot of Master/ })
      .waitFor();
    const reads = server.requests.filter((request) => request.path.endsWith('/versions')).length;
    operations = [
      snapshot({
        state: 'succeeded',
        progress: { doneBytes: null, totalBytes: null },
        finishedAt: new Date().toISOString(),
      }),
      clone({
        state: 'failed',
        progress: { doneBytes: null, totalBytes: null },
        error: {
          code: 'repository_unreachable',
          message: 'The repository did not answer in time.',
        },
        recovery: 'Check that the SSH server is running and reachable, and try again.',
        finishedAt: new Date().toISOString(),
      }),
    ];
    const notices = page.getByRole('list', { name: 'Ended operations' });
    await notices.getByText('Snapshot created: DOS622_202611271430').waitFor({ timeout: 10_000 });
    await notices.getByText('Clone failed: DOS622_Office').waitFor();
    await expect
      .poll(() => server.requests.filter((request) => request.path.endsWith('/versions')).length)
      .toBeGreaterThan(reads);
    await shot(page, 'vh-ended');
    await page.context().close();
  });

  it('says the status is unavailable, without the spinner, and recovers by itself', async () => {
    operations = [snapshot()];
    listingFails = false;
    const page = await open(`${VM_PATH}/versions`);
    await card(page, MASTER)
      .getByRole('button', { name: 'Creating snapshot of Master: Transferring 62%' })
      .waitFor();
    listingFails = true;
    const stale = card(page, MASTER).getByRole('button', {
      name: 'Creating snapshot of Master: Transferring 62%, status unavailable',
    });
    await stale.waitFor({ timeout: 10_000 });
    expect(await stale.locator('svg.icon-spin').count()).toBe(0);
    await shot(page, 'vh-unavailable');
    listingFails = false;
    await card(page, MASTER)
      .getByRole('button', { name: 'Creating snapshot of Master: Transferring 62%' })
      .waitFor({ timeout: 10_000 });
    await page.context().close();
    // The failed reads are the browser's own 503 messages, which this test caused on purpose.
    consoleErrors.splice(
      0,
      consoleErrors.length,
      ...consoleErrors.filter((line) => !/503/.test(line)),
    );
  });
});

describe.skipIf(CAPTURE_ONLY)('General', () => {
  it('has one toolbar, a metadata editor, Info for the details, and the same operation as Version History', async () => {
    operations = [snapshot(), clone()];
    const page = await open(VM_PATH);
    const toolbar = page.getByRole('toolbar', { name: 'VM actions' });
    await toolbar.waitFor();
    await toolbar.getByRole('button', { name: 'Make public' }).waitFor();
    expect(await page.getByRole('heading', { name: 'Details' }).count()).toBe(0);
    const now = page.getByRole('region', { name: 'Now' });
    await now
      .getByRole('button', { name: 'Creating snapshot of Master: Transferring 62%' })
      .waitFor();
    await now.getByText('No VM session is running.').waitFor();
    // The modes keep their names, with an icon each.
    for (const name of ['Local', 'Remote Volatile', 'Remote Snapshot']) {
      const label = page.locator('.execution-mode-name', { hasText: name });
      expect(await label.locator('svg').count()).toBe(1);
    }
    expect(await noSidewaysScroll(page)).toBe(true);
    await shot(page, 'general-active-light');
    await shot(page, 'general-active-light-full', true);

    await toolbar.getByRole('button', { name: 'VM information' }).click();
    const info = page.getByRole('dialog', { name: 'MS-DOS 6.22' });
    await info.waitFor();
    const text = await info.innerText();
    for (const fact of [
      'Private.',
      'Emulator',
      '86box',
      'DOS622',
      'Versions',
      '5',
      'Media',
      'Registered',
      'Updated',
    ]) {
      expect(text).toContain(fact);
    }
    const box = await info.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
    await shot(page, 'general-info');
    await page.keyboard.press('Escape');

    // Unsaved changes are said, and nothing is sent until Save.
    await page.getByLabel('Display name').fill('MS-DOS 6.22 (486)');
    await page
      .getByRole('toolbar', { name: 'Metadata actions' })
      .getByText('Unsaved changes')
      .waitFor();
    await shot(page, 'general-unsaved');
    expect(server.requests.some((request) => request.method !== 'GET')).toBe(false);

    // The same operation, from the same list, in Version History.
    await page
      .getByRole('navigation', { name: 'VM' })
      .getByRole('link', { name: 'Version History' })
      .click();
    await card(page, MASTER)
      .getByRole('button', { name: 'Creating snapshot of Master: Transferring 62%' })
      .waitFor();
    await page.context().close();
  });

  it('works in the dark theme and on a phone', async () => {
    operations = [clone()];
    for (const [name, options] of [
      ['general-active-dark', { theme: 'dark' }],
      ['general-active-narrow', { width: 390, height: 844 }],
    ] as const) {
      const page = await open(VM_PATH, options);
      await page
        .getByRole('button', { name: /^Operations of this VM: 1 operation running/ })
        .waitFor();
      expect(await noSidewaysScroll(page)).toBe(true);
      await shot(page, name);
      await shot(page, `${name}-full`, true);
      await page.context().close();
    }
  });

  it('logged no console error', () => {
    expect(consoleErrors).toEqual([]);
  });
});
