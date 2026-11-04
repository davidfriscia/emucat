import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    expect(config.archiveRepository.kind).toBe('none');
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

  it('rejects an invalid repository kind', () => {
    expect(() => loadConfig({ DB_PASSWORD: 'x', ARCHIVE_REPOSITORY_KIND: '../s3' })).toThrow(
      /ARCHIVE_REPOSITORY_KIND/,
    );
  });
});
