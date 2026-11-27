/**
 * Version History in a real browser: the production build of the whole application, served as the web container's
 * nginx serves it (its MIME table, `nosniff`, `try_files … /index.html`), against a stand-in for the API that
 * answers only what the page reads and records every request. It proves what jsdom cannot: the layout (card height,
 * one toolbar row on a wide screen, no horizontal scrolling on a narrow one), tooltips shown on hover and on keyboard
 * focus, the Info panels inside the window, both themes, and that no action is taken by merely looking.
 *
 * Run with `pnpm --filter @emucat/web test:browser`. The browser is Edge or Chrome, or `EMUCAT_BROWSER_PATH`.
 * Screenshots and measurements are written to `EMUCAT_BROWSER_SCREENSHOTS` when set.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type HarnessServer, type RecordedRequest } from './server';
import {
  adminVm,
  AGENT_NAME,
  MASTER,
  remasterPreview,
  restoreOptions,
  SESSION,
  SNAP_A,
  SNAP_D,
  tree,
  VM_PATH,
  type Scenario,
} from './version-history-fixtures';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(WEB, 'e2e', 'dist-app');
const SHOTS = process.env.EMUCAT_BROWSER_SCREENSHOTS ?? null;
const SHOT_PREFIX = process.env.EMUCAT_BROWSER_SCREENSHOT_PREFIX ?? 'version-history';
const PAGE = `${VM_PATH}/versions`;

let server: HarnessServer;
let browser: Browser;
let scenario: Scenario = 'branches';
const consoleErrors: string[] = [];
const measurements: Record<string, unknown>[] = [];

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
  options: { theme?: 'light' | 'dark'; width?: number; height?: number; scenario?: Scenario } = {},
): Promise<Page> {
  scenario = options.scenario ?? 'branches';
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 1000 },
    deviceScaleFactor: SHOTS ? 2 : 1,
    colorScheme: options.theme ?? 'light',
  });
  // The application keeps the chosen theme in local storage; the stand-in session decides nothing else.
  await context.addInitScript((theme) => {
    try {
      localStorage.setItem('emucat.theme', theme);
    } catch {
      // Storage may be unavailable; the colour scheme of the context then applies.
    }
  }, options.theme ?? 'light');
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(`${server.url}${PAGE}`);
  await page.getByRole('tree', { name: `Versions of ${tree(scenario).vmName}` }).waitFor();
  return page;
}

async function shot(page: Page, name: string, fullPage = true) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${SHOT_PREFIX}-${name}.png`), fullPage });
}

/** The card of one version, by its identity (the short identifier's title is the full one). */
const card = (page: Page, id: string) =>
  page.locator(`li[aria-labelledby="version-${id}"] > .version-card`);

/** Heights and visible rows: what the redesign is meant to make more compact. */
async function measure(page: Page, label: string) {
  const result = await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>('.version-card')];
    const viewport = window.innerHeight;
    const tree = document.querySelector<HTMLElement>('[role="tree"]');
    const top = tree?.getBoundingClientRect().top ?? 0;
    return {
      cardHeights: cards.map((item) => Math.round(item.getBoundingClientRect().height)),
      treeTop: Math.round(top),
      versionsFullyVisible: cards.filter((item) => item.getBoundingClientRect().bottom <= viewport)
        .length,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  measurements.push({ label, ...result });
  return result;
}

beforeAll(async () => {
  execFileSync(
    'npx',
    ['vite', 'build', '--outDir', 'e2e/dist-app', '--emptyOutDir', '--logLevel', 'warn'],
    { cwd: WEB, stdio: 'inherit' },
  );
  server = await startServer(DIST, { fallback: 'index.html' });
  answer('GET /ready', () => ({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } }));
  answer('GET /auth/session', () => SESSION);
  answer('GET /setup/status', () => ({ setupRequired: false }));
  answer(`GET ${VM_PATH}`, () => adminVm(scenario));
  answer(`GET ${VM_PATH}/versions`, () => tree(scenario));
  answer(`GET ${VM_PATH}/workspaces`, () => ({ workspaces: [] }));
  answer(`GET ${VM_PATH}/restore-options`, () => restoreOptions(scenario));
  answer(`GET ${VM_PATH}/remasters`, () => ({ remasters: [] }));
  answer(`GET ${VM_PATH}/remaster/local`, () => remasterPreview(scenario));
  answer(`GET ${VM_PATH}/media`, () => ({ media: [] }));
  answer('GET /admin/restores', () => ({ operations: [] }));
  answer('GET /admin/local-copy-removals', () => ({ removals: [] }));
  // Decision 0060: the VM's operations. None here; e2e/operations.browser.test.ts shows them.
  answer(`GET ${VM_PATH}/operations`, () => ({
    operations: [],
    retentionHours: 24,
    serverTime: new Date().toISOString(),
  }));
  browser = await launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (measurements.length) {
    console.log(JSON.stringify(measurements, null, 2));
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      writeFileSync(
        join(SHOTS, `${SHOT_PREFIX}-measurements.json`),
        JSON.stringify(measurements, null, 2),
      );
    }
  }
});

describe('Version History, captured for comparison', () => {
  it('captures each scenario at the same size, whatever the design', async () => {
    for (const [name, options] of [
      ['1-master-only', { scenario: 'single' }],
      ['2-one-snapshot', { scenario: 'one' }],
      ['3-branches-light', { scenario: 'branches' }],
      ['8-branches-dark', { scenario: 'branches', theme: 'dark' }],
      ['10-narrow', { scenario: 'branches', width: 390, height: 844 }],
    ] as const) {
      const page = await open(options);
      await measure(page, name);
      await shot(page, name, false);
      await shot(page, `${name}-full`);
      await page.context().close();
    }
  });
});

describe('Version History', () => {
  it('draws compact cards, with one toolbar row per version on a wide screen', async () => {
    const page = await open();
    const result = await measure(page, 'assert-wide');
    // Each card is the identity, a summary line and one toolbar row: far shorter than the 186-237 px they were.
    for (const height of result.cardHeights) expect(height).toBeLessThan(130);
    expect(result.versionsFullyVisible).toBe(5);
    for (const id of [MASTER, SNAP_A, SNAP_D]) {
      const rows = await card(page, id)
        .getByRole('toolbar')
        .evaluate((toolbar) => {
          const tops = new Set(
            [...toolbar.querySelectorAll('button')].map((button) =>
              Math.round(button.getBoundingClientRect().top),
            ),
          );
          return tops.size;
        });
      expect(rows).toBe(1);
    }
    // Every action is an icon with a name of its own, in the same order on every card.
    const names = await card(page, SNAP_A)
      .getByRole('toolbar')
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
    expect(names).toEqual([
      'Restore DOS622_202611182136',
      'Run DOS622_202611182136 in Remote Volatile',
      'Run DOS622_202611182136 in Remote Snapshot',
      'Edit details of DOS622_202611182136',
      'Tags of DOS622_202611182136',
      'Clone DOS622_202611182136 into a new VM',
      'View the archive contents of DOS622_202611182136',
      'Promote DOS622_202611182136 to master',
      'Delete DOS622_202611182136',
      'Information about DOS622_202611182136',
    ]);
    // The master offers no lifecycle action, and names the agent of its local copy.
    const master = card(page, MASTER);
    expect(await master.getByRole('button', { name: /^Delete|^Promote/ }).count()).toBe(0);
    await master
      .getByRole('button', {
        name: `Create snapshot of Master from the local copy on ${AGENT_NAME}`,
      })
      .waitFor();
    await page.context().close();
  });

  it('shows a tooltip on hover and on keyboard focus, and a disabled action’s reason', async () => {
    const page = await open();
    const restore = card(page, MASTER).getByRole('button', { name: 'Restore Master' });
    await restore.hover();
    const tip = restore.locator('.icon-tooltip');
    await expect.poll(() => tip.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
    expect(await tip.innerText()).toBe('Restore version');

    // Unavailable, yet reachable by keyboard with its reason, and inert.
    const remove = card(page, SNAP_A).getByRole('button', { name: 'Delete DOS622_202611182136' });
    expect(await remove.getAttribute('aria-disabled')).toBe('true');
    await card(page, SNAP_A)
      .getByRole('button', { name: /^Promote/ })
      .focus();
    await page.keyboard.press('Tab');
    expect(await remove.evaluate((node) => node === document.activeElement)).toBe(true);
    const reason = remove.locator('.icon-tooltip');
    await expect.poll(() => reason.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
    expect(await reason.innerText()).toMatch(
      /^Delete snapshot unavailable\s+No online agent can reach this snapshot’s repository/,
    );
    await shot(page, '7-disabled-action-tooltip', false);
    await page.keyboard.press('Enter');
    await remove.click({ force: true });
    expect(await page.getByRole('dialog').count()).toBe(0);
    await page.context().close();
  });

  it('gives each version’s metadata on demand, inside the window, and gives the focus back', async () => {
    const page = await open();
    const info = card(page, MASTER).getByRole('button', { name: 'Information about Master' });
    await info.click();
    const panel = page.getByRole('dialog', { name: 'Master' });
    await panel.waitFor();
    const text = await panel.innerText();
    for (const fact of [
      MASTER,
      'None (root)',
      '258.1 MiB',
      'My Storage',
      'Verified by the agent when published: 7 files, 677.0 MiB',
      'does not say that the archive, or any local copy, has been verified since',
      `Local copy on ${AGENT_NAME} (not verified since it reconnected)`,
      'Ada Admin',
    ]) {
      expect(text).toContain(fact);
    }
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
    await shot(page, '6-version-info', false);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });
    expect(await info.evaluate((node) => node === document.activeElement)).toBe(true);

    // The page's own Info holds the explanation the page used to print.
    await page.getByRole('button', { name: 'About the version history' }).click();
    const about = page.getByRole('dialog', { name: 'About the version history' });
    expect(await about.innerText()).toMatch(/full, immutable archive/);
    await page.keyboard.press('Escape');
    await page.context().close();
  });

  it('opens the same dialogs as before, and never acts on its own', async () => {
    const page = await open();
    await card(page, SNAP_D)
      .getByRole('button', { name: /^Delete / })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Permanently delete this snapshot' });
    await dialog.waitFor();
    expect(await dialog.getByText(SNAP_D, { exact: true }).count()).toBe(1);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Remaster from local copy' }).click();
    const remaster = page.getByRole('dialog', { name: 'Remaster from a local copy' });
    await remaster.waitFor();
    await remaster.getByRole('button', { name: 'Cancel' }).click();
    await remaster.waitFor({ state: 'detached' });

    await card(page, SNAP_A).getByRole('button', { name: 'Restore DOS622_202611182136' }).click();
    // With a local copy on the only agent, restoring this version replaces that copy.
    const restore = page.getByRole('dialog', { name: 'Replace the local copy of DOS622' });
    await restore.waitFor();
    expect(await restore.getByLabel('Version').inputValue()).toBe(SNAP_A);
    await restore.getByRole('button', { name: 'Cancel' }).click();

    // Looking, hovering and opening dialogs only ever read.
    expect(server.requests.some((request) => request.method !== 'GET')).toBe(false);
    await page.context().close();
  });

  it('collapses and expands a branch, keeping the tree as it is', async () => {
    const page = await open();
    const levels = await page
      .getByRole('treeitem')
      .evaluateAll((items) => items.map((item) => item.getAttribute('aria-level')));
    expect(levels).toEqual(['1', '2', '2', '3', '4']);
    const collapse = page.getByRole('button', {
      name: 'Collapse Sound Blaster 16 and CD-ROM drivers installed',
    });
    // Named by its label, not its title: the label is what identifies a version.
    expect(await collapse.count()).toBe(0);
    await page.getByRole('button', { name: 'Collapse DOS622_202611201015' }).click();
    expect(await page.getByRole('treeitem').count()).toBe(3);
    await page.getByRole('button', { name: 'Expand DOS622_202611201015' }).click();
    expect(await page.getByRole('treeitem').count()).toBe(5);
    await page.context().close();
  });

  it('puts icons beside the VM sidebar’s labels, never instead of them', async () => {
    const page = await open();
    const nav = page.getByRole('navigation', { name: 'VM' });
    for (const label of [
      'General',
      'Version History',
      'Local copies and restore',
      'Notes',
      'Screenshots',
    ]) {
      const link = nav.getByRole('link', { name: label, exact: true });
      expect(await link.locator('svg').count()).toBe(1);
      expect((await link.innerText()).trim()).toBe(label);
    }
    expect(
      await nav.getByRole('link', { name: 'Version History' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(await page.getByRole('link', { name: 'Back to Catalog' }).locator('svg').count()).toBe(
      1,
    );
    await page.context().close();
  });

  it('works in both themes, without the old coloured borders', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await open({ theme });
      expect(await page.locator('html').getAttribute('data-bs-theme')).toBe(theme);
      // No action keeps a coloured border at rest.
      const borders = await page
        .locator('.version-toolbar .icon-button')
        .evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).borderTopColor));
      expect(new Set(borders).size).toBe(1);
      expect(await page.locator('.version-card .btn-outline-danger').count()).toBe(0);
      await shot(page, `9-theme-${theme}`, false);
      await page.context().close();
    }
  });

  it('stays usable on a phone: no sideways scrolling, every action and Info reachable', async () => {
    const page = await open({ width: 390, height: 844 });
    const result = await measure(page, 'assert-narrow');
    expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth);
    const deepest = card(page, SNAP_D);
    for (const name of [/^Restore /, /^Delete /, /^Information about /]) {
      const box = await deepest.getByRole('button', { name }).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
    await deepest.getByRole('button', { name: /^Information about / }).click();
    const panel = page.getByRole('dialog', { name: /Windows 3\.11/ });
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await shot(page, '10-narrow-info', false);
    await page.context().close();
  });

  it('opens Archive Explorer from View contents', async () => {
    const page = await open();
    const before = consoleErrors.length;
    await card(page, MASTER)
      .getByRole('button', { name: 'View the archive contents of Master' })
      .click();
    await page.getByRole('dialog', { name: 'Archive Explorer' }).waitFor();
    // The stand-in has no archive, so the explorer reports it; only that failed request may be logged.
    for (const message of consoleErrors.splice(before)) {
      expect(message).toMatch(/Failed to load resource/);
    }
    await page.context().close();
  });

  it('logged no error in the browser console', () => {
    expect(consoleErrors).toEqual([]);
  });
});
