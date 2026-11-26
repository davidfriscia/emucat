/**
 * What a failed browser test leaves behind, for diagnosis. With EMUCAT_E2E_ARTIFACTS set to a directory, every page
 * still open when a test fails is saved there as `<test>/<n>.png` (full page), `<n>.html` (the DOM), and `<n>.txt`
 * (its URL, the browser console, failed requests and 4xx/5xx responses). Without it, nothing is recorded or written.
 * Tests close their browser context when they pass, so what is open after a failure is the failing test's own page.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright-core';
import { afterEach } from 'vitest';

const target = process.env.EMUCAT_E2E_ARTIFACTS;
const journals = new WeakMap<BrowserContext, string[]>();

/** Records each new context's console and network failures. Call once, right after launching the browser. */
export function recordBrowser(browser: Browser): Browser {
  if (!target) return browser;
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...options) => {
    const context = await newContext(...options);
    const journal: string[] = [];
    journals.set(context, journal);
    const stamp = () => new Date().toISOString();
    context.on('console', (message) =>
      journal.push(`${stamp()} console.${message.type()} ${message.text()}`),
    );
    context.on('weberror', (error) =>
      journal.push(`${stamp()} page error ${error.error().message}`),
    );
    context.on('requestfailed', (request) =>
      journal.push(
        `${stamp()} request failed ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
      ),
    );
    context.on('response', (response) => {
      if (response.status() >= 400) {
        journal.push(
          `${stamp()} ${response.status()} ${response.request().method()} ${response.url()}`,
        );
      }
    });
    return context;
  };
  return browser;
}

/** Saves the open pages of `browser()` after each failed test of the calling file. */
export function captureFailures(browser: () => Browser | undefined): void {
  if (!target) return;
  afterEach(async ({ task }) => {
    if (task.result?.state !== 'fail') return;
    const open = browser();
    if (!open) return;
    const name = task.name.replace(/[^\w.-]+/gu, '_').slice(0, 120);
    const directory = join(target, name);
    await mkdir(directory, { recursive: true });
    let index = 0;
    for (const context of open.contexts()) {
      for (const page of context.pages()) {
        index += 1;
        const base = join(directory, String(index));
        await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => undefined);
        await writeFile(`${base}.html`, await page.content().catch((error) => String(error)));
        await writeFile(
          `${base}.txt`,
          [`url ${page.url()}`, ...(journals.get(context) ?? [])].join('\n') + '\n',
        );
      }
    }
  });
}
