import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandLogo, BrandMark, Mascot } from '../src/components/Brand';
import { mockApi, renderAt, resetApiState } from './mock-api';

// Vitest runs with this package as the working directory.
const BRAND_DIRECTORY = join(process.cwd(), 'src', 'assets', 'brand');
const readBrand = (file: string) => readFileSync(join(BRAND_DIRECTORY, file), 'utf8');
const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  resetApiState();
});

describe('brand assets', () => {
  const files = readdirSync(BRAND_DIRECTORY).filter((file) => file.endsWith('.svg'));

  it('include everything the guidelines promise', () => {
    expect(files.sort()).toEqual(
      [
        'favicon.svg',
        'logo-dark.svg',
        'logo-light.svg',
        'mark.svg',
        'mascot.svg',
        'wordmark.svg',
      ].sort(),
    );
  });

  it.each(files)(
    '%s is a self-contained vector, with no scripts or external references',
    (file) => {
      const svg = readBrand(file);
      expect(svg).toMatch(/^<svg /);
      expect(svg).toContain('viewBox=');
      expect(svg).not.toMatch(/<script|<image|<foreignObject|on[a-z]+=|href=|url\(/i);
      expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:/);
    },
  );

  const wordmarkPaths = (svg: string) =>
    [...svg.matchAll(/stroke="[^"]+" d="([^"]+)"/g)].map((match) => match[1]);
  const headPath = (svg: string) => /d="(M10 9 [^"]+)"/.exec(svg)?.[1];

  it.each(['logo-light.svg', 'logo-dark.svg'])('%s has the same artwork as the app', (file) => {
    expect(wordmarkPaths(readBrand(file))).toEqual(wordmarkPaths(readBrand('wordmark.svg')));
    expect(headPath(readBrand(file))).toBe(headPath(readBrand('mark.svg')));
  });

  it('use the same cat in the favicon and the mascot', () => {
    expect(headPath(readBrand('favicon.svg'))).toBe(headPath(readBrand('mark.svg')));
    expect(headPath(readBrand('mascot.svg'))).toBe(headPath(readBrand('mark.svg')));
  });

  it('give the favicon a dark variant', () => {
    expect(readBrand('favicon.svg')).toContain('prefers-color-scheme: dark');
  });

  it('are linked from the page', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('href="/src/assets/brand/favicon.svg"');
  });
});

describe('theme variants', () => {
  const blockFor = (selector: string) => {
    const start = styles.indexOf(`${selector} {`);
    return styles.slice(start, styles.indexOf('}', start));
  };
  const variablesIn = (text: string) =>
    [...text.matchAll(/(--emucat-[a-z-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value]);

  const light = Object.fromEntries(variablesIn(blockFor("[data-bs-theme='light']")));
  const dark = Object.fromEntries(variablesIn(blockFor("[data-bs-theme='dark']")));

  it('define the same brand colors for light and dark', () => {
    expect(Object.keys(light).length).toBeGreaterThan(5);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  it('differ between light and dark where it matters', () => {
    expect(dark['--emucat-word-primary']).not.toBe(light['--emucat-word-primary']);
    expect(dark['--emucat-cat-body']).not.toBe(light['--emucat-cat-body']);
  });

  it('supply every color variable the artwork uses', () => {
    const used = new Set(
      ['mark.svg', 'mascot.svg', 'wordmark.svg'].flatMap((file) =>
        [...readBrand(file).matchAll(/var\((--emucat-[a-z-]+)/g)].map((match) => match[1]),
      ),
    );
    expect(used.size).toBeGreaterThan(3);
    for (const variable of used) {
      expect(light).toHaveProperty([variable as string]);
      expect(dark).toHaveProperty([variable as string]);
    }
  });

  it('give every artwork color a light-theme fallback, for use outside the app', () => {
    for (const file of ['mark.svg', 'mascot.svg', 'wordmark.svg']) {
      expect(readBrand(file)).not.toMatch(/var\(--emucat-[a-z-]+\)/);
    }
  });

  it('use the fixed-color logo that suits each background', () => {
    expect(readBrand('logo-light.svg')).toContain('#134e4a');
    expect(readBrand('logo-dark.svg')).toContain('#f0fdfa');
  });
});

describe('brand components', () => {
  it('keeps the name in the accessible tree when the wordmark is artwork', () => {
    render(<BrandLogo />);
    expect(screen.getByText('EmuCat')).toBeTruthy();
    expect(document.querySelectorAll('svg').length).toBe(2);
  });

  it('is decorative unless given a label', () => {
    render(<BrandMark />);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('can be labelled', () => {
    render(<BrandMark label="EmuCat logo" />);
    expect(screen.getByRole('img', { name: 'EmuCat logo' })).toBeTruthy();
  });

  it.each(['idle', 'sleeping', 'puzzled'] as const)('draws the mascot %s', (mood) => {
    const { container } = render(<Mascot mood={mood} labelled />);
    expect(container.querySelector(`[data-mood="${mood}"]`)).not.toBeNull();
    expect(container.querySelector(`.mascot-${mood}`)).not.toBeNull();
    expect(screen.getByRole('img')).toBeTruthy();
  });

  it('shows the logo in the navigation, linking home', async () => {
    mockApi();
    renderAt('/');
    const nav = screen.getByRole('navigation');
    const home = within(nav).getByRole('link', { name: 'EmuCat' });
    expect(home.getAttribute('href')).toBe('/');
    expect(home.querySelector('svg')).not.toBeNull();
    await screen.findByRole('heading', { name: 'No virtual machines yet' });
  });

  it('uses the sleeping mascot on empty states', async () => {
    mockApi();
    renderAt('/');
    await screen.findByRole('heading', { name: 'No virtual machines yet' });
    expect(document.querySelector('main [data-mood="sleeping"]')).not.toBeNull();
  });

  it('uses the puzzled mascot on errors and unknown pages', async () => {
    mockApi();
    renderAt('/no/such/page');
    expect(document.querySelector('main [data-mood="puzzled"]')).not.toBeNull();
    await screen.findByRole('heading', { name: 'Page not found' });
  });
});
