import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ARCHIVE_POLICY } from '../src/archives/policy.js';
import { ConfigError, loadConfig } from '../src/config.js';

describe('API configuration', () => {
  it('requires a database password', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DB_PASSWORD/);
    expect(() => loadConfig({ DB_PASSWORD: '' })).toThrow(/DB_PASSWORD/);
  });

  it('applies defaults and resolves the storage path', () => {
    const config = loadConfig({ DB_PASSWORD: 'x' });
    expect(config.port).toBe(4000);
    expect(config.host).toBe('127.0.0.1');
    expect(isAbsolute(config.storagePath)).toBe(true);
  });

  it('reads overrides', () => {
    const config = loadConfig({ DB_PASSWORD: 'x', API_PORT: '5000', DB_PORT: '3310' });
    expect(config.port).toBe(5000);
    expect(config.database.port).toBe(3310);
  });

  it('rejects invalid values without echoing secrets', () => {
    const attempt = () => loadConfig({ DB_PASSWORD: 'super-secret', API_PORT: 'not-a-port' });
    expect(attempt).toThrow(/API_PORT/);
    expect(attempt).not.toThrow(/super-secret/);
  });

  it('applies the archive policy defaults, reads overrides, and refuses values out of range', () => {
    const defaults = loadConfig({ DB_PASSWORD: 'x' }).archives;
    expect(defaults).toEqual(DEFAULT_ARCHIVE_POLICY);
    const tuned = loadConfig({
      DB_PASSWORD: 'x',
      ARCHIVE_CACHE_MAX_BYTES: '33554432',
      ARCHIVE_PREVIEW_TEXT_BYTES: '65536',
      ARCHIVE_DOWNLOAD_MAX_BYTES: '0',
      ARCHIVE_PREVIEW_TIMEOUT_SECONDS: '30',
      ARCHIVE_INSPECTION_MAX_ENTRIES: '',
    }).archives;
    expect(tuned.cache.maxBytes).toBe(33_554_432);
    expect(tuned.preview.textBytes).toBe(65_536);
    expect(tuned.preview.timeoutMs).toBe(30_000);
    expect(tuned.download.maxBytes).toBe(0);
    expect(tuned.inspection.maxEntries).toBe(DEFAULT_ARCHIVE_POLICY.inspection.maxEntries);
    expect(() => loadConfig({ DB_PASSWORD: 'x', ARCHIVE_PREVIEW_MAX_CONCURRENT: '0' })).toThrow(
      /ARCHIVE_PREVIEW_MAX_CONCURRENT/,
    );
    expect(() =>
      loadConfig({ DB_PASSWORD: 'x', ARCHIVE_INSPECTION_MAX_ENTRIES: '900000' }),
    ).toThrow(/ARCHIVE_INSPECTION_MAX_ENTRIES/);
  });
});
