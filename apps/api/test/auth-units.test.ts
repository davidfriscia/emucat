import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPasswordHasher, DEFAULT_PASSWORD_HASHING } from '../src/auth/passwords.js';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import { generateSessionToken } from '../src/auth/sessions.js';
import { createSetupToken } from '../src/auth/setup.js';
import { loadConfig } from '../src/config.js';
import { InvalidStorageKeyError, resolveStorageKey } from '../src/storage/media-storage.js';

const cheap = createPasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });

describe('password hashing', () => {
  it('produces Argon2id with the configured parameters', async () => {
    const hash = await createPasswordHasher().hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(DEFAULT_PASSWORD_HASHING.memoryCost).toBeGreaterThanOrEqual(19_456);
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const hash = await cheap.hash('correct horse battery');
    expect(await cheap.verify(hash, 'correct horse battery')).toBe(true);
    expect(await cheap.verify(hash, 'correct horse batterz')).toBe(false);
    expect(await cheap.verify(hash, 'correct horse battery ')).toBe(false);
    expect(await cheap.verify(hash, '')).toBe(false);
  });

  it('salts: the same password hashes differently each time', async () => {
    expect(await cheap.hash('same password')).not.toBe(await cheap.hash('same password'));
  });

  it('handles Unicode passwords exactly', async () => {
    const hash = await cheap.hash('pässwörd 日本語 🐈');
    expect(await cheap.verify(hash, 'pässwörd 日本語 🐈')).toBe(true);
    expect(await cheap.verify(hash, 'passwörd 日本語 🐈')).toBe(false);
  });

  it.each(['', 'not-a-hash', '$argon2id$', 'plain text password', '$2b$10$abcdefghijklmnop'])(
    'treats the malformed stored hash %j as a failed login',
    async (stored) => {
      expect(await cheap.verify(stored, 'plain text password')).toBe(false);
    },
  );

  it('reuses one dummy hash, and never reports success from it', async () => {
    await expect(cheap.verifyAgainstDummy('anything')).resolves.toBeUndefined();
    await expect(cheap.verifyAgainstDummy('emucat-dummy-password')).resolves.toBeUndefined();
  });
});

describe('setup token', () => {
  const CONFIGURED = 'a-configured-setup-token-of-plenty-of-characters';

  it('announces a generated token once, and never one the operator configured', () => {
    const generated = createSetupToken();
    const seen: string[] = [];
    generated.announce((token) => seen.push(token));
    generated.announce((token) => seen.push(token));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.length).toBeGreaterThanOrEqual(32);
    expect(generated.matches(seen[0] as string)).toBe(true);
    expect(generated.matches('')).toBe(false);

    const configured = createSetupToken(CONFIGURED);
    configured.announce(() => {
      throw new Error('Must not be announced');
    });
    expect(configured.matches(CONFIGURED)).toBe(true);
    expect(configured.matches(`${CONFIGURED}x`)).toBe(false);
  });

  it('generates a different token for each process', () => {
    const tokens: string[] = [];
    createSetupToken().announce((token) => tokens.push(token));
    createSetupToken().announce((token) => tokens.push(token));
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});

describe('session tokens', () => {
  it('have 256 bits of URL-safe randomness', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('rate limiter', () => {
  const rule = { maxAttempts: 2, windowSeconds: 60 };

  it('allows up to the limit, then says when to retry', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(() => now);
    const keys = [{ key: 'a', rule }];
    expect(limiter.attempt(keys).allowed).toBe(true);
    expect(limiter.attempt(keys).allowed).toBe(true);
    expect(limiter.attempt(keys)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    now += 30_000;
    expect(limiter.attempt(keys)).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it('opens again after the window', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const keys = [{ key: 'a', rule }];
    limiter.attempt(keys);
    limiter.attempt(keys);
    now += 60_000;
    expect(limiter.attempt(keys).allowed).toBe(true);
  });

  it('gives back released attempts', () => {
    const limiter = new RateLimiter();
    const keys = [{ key: 'a', rule }];
    for (let index = 0; index < 10; index += 1) {
      expect(limiter.attempt(keys).allowed).toBe(true);
      limiter.release(keys);
    }
  });

  it('counts against all keys, or against none if any is exhausted', () => {
    const limiter = new RateLimiter();
    const a = { key: 'a', rule: { maxAttempts: 1, windowSeconds: 60 } };
    const b = { key: 'b', rule: { maxAttempts: 2, windowSeconds: 60 } };
    expect(limiter.attempt([a, b]).allowed).toBe(true);
    expect(limiter.attempt([a, b]).allowed).toBe(false);
    // The refused attempt did not use up b's remaining allowance.
    expect(limiter.attempt([b]).allowed).toBe(true);
    expect(limiter.attempt([b]).allowed).toBe(false);
  });

  it('keeps separate keys separate', () => {
    const limiter = new RateLimiter();
    limiter.attempt([{ key: 'a', rule: { maxAttempts: 1, windowSeconds: 60 } }]);
    expect(
      limiter.attempt([{ key: 'b', rule: { maxAttempts: 1, windowSeconds: 60 } }]).allowed,
    ).toBe(true);
  });

  it('bounds its memory under a flood of distinct keys', () => {
    const limiter = new RateLimiter();
    for (let index = 0; index < 60_000; index += 1) {
      limiter.attempt([{ key: `flood-${index}`, rule }]);
    }
    const tracked = (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size;
    expect(tracked).toBeLessThanOrEqual(50_000);
  });
});

describe('storage keys', () => {
  const root = resolve('storage-root');

  it('resolves a relative key under the root', () => {
    expect(resolveStorageKey(root, 'media/a/full.jpg')).toBe(join(root, 'media', 'a', 'full.jpg'));
  });

  // The formats the API writes (media files and staging); they must keep resolving on every platform.
  it.each([
    'media/full/0b9f1c1e-3c55-4f0a-9d1e-6a2b1f3c4d5e.jpg',
    'media/thumbnails/0b9f1c1e-3c55-4f0a-9d1e-6a2b1f3c4d5e.jpg',
    'media/originals/0b9f1c1e-3c55-4f0a-9d1e-6a2b1f3c4d5e.png',
    'media/staging',
    'C/Windows', // a directory named C, not a drive
    'a..b/c.d',
  ])('accepts %j', (key) => {
    expect(resolveStorageKey(root, key)).toBe(join(root, ...key.split('/')));
  });

  // Every form that names something outside the root on some platform is refused on all of them: the
  // check may not depend on what the host's node:path happens to consider absolute.
  it.each([
    '',
    '..',
    '../secret',
    'a/../../secret',
    'a/./b',
    'a//b',
    'a/',
    '/',
    '/etc/passwd',
    '//server/share/file',
    'C:/Windows/win.ini',
    'c:/windows/win.ini',
    'C:\\Windows\\win.ini',
    'C:',
    'C:foo',
    'C:foo/bar',
    'Z:/',
    '\\\\server\\share\\file',
    '\\Windows\\win.ini',
    '..\\secret',
    'a\\b',
    'a\0b',
    '\0',
    '.',
  ])('refuses %j', (key) => {
    expect(() => resolveStorageKey(root, key)).toThrow(InvalidStorageKeyError);
  });
});

describe('authentication configuration', () => {
  const base = { DB_PASSWORD: 'x' };

  it('has safe defaults', () => {
    const config = loadConfig(base);
    expect(config.cookieSecure).toBe(false);
    expect(config.setupToken).toBeUndefined();
    expect(config.publicOrigin).toBeUndefined();
    expect(config.trustProxy).toEqual([]);
    expect(config.sessionIdleTtlSeconds).toBe(7 * 24 * 3600);
    expect(config.sessionAbsoluteTtlSeconds).toBe(30 * 24 * 3600);
  });

  it('turns on Secure cookies in production', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).cookieSecure).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: '' }).cookieSecure).toBe(
      true,
    );
  });

  it('lets an explicit setting win', () => {
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).cookieSecure,
    ).toBe(false);
    expect(loadConfig({ ...base, COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
  });

  it('treats empty settings as unset', () => {
    const config = loadConfig({ ...base, SETUP_TOKEN: '', PUBLIC_ORIGIN: '', TRUST_PROXY: '' });
    expect(config.setupToken).toBeUndefined();
    expect(config.publicOrigin).toBeUndefined();
    expect(config.trustProxy).toEqual([]);
  });

  it('refuses a short setup token', () => {
    expect(() => loadConfig({ ...base, SETUP_TOKEN: 'short' })).toThrow(/SETUP_TOKEN/);
  });

  it('never echoes the setup token in an error', () => {
    expect(() => loadConfig({ ...base, SETUP_TOKEN: 'short-secret' })).not.toThrow(/short-secret/);
  });

  it('normalizes the public origin and parses proxies', () => {
    const config = loadConfig({
      ...base,
      PUBLIC_ORIGIN: 'https://emucat.example/',
      TRUST_PROXY: '10.0.0.1, 192.168.0.0/16',
    });
    expect(config.publicOrigin).toBe('https://emucat.example');
    expect(config.trustProxy).toEqual(['10.0.0.1', '192.168.0.0/16']);
  });

  it('refuses a bad public origin', () => {
    expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: 'emucat' })).toThrow(/PUBLIC_ORIGIN/);
  });
});
