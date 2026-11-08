import { describe, expect, it } from 'vitest';
import { DeployerConfigError, loadDeployerConfig } from '../src/config.ts';
import { parseEnvFile } from '../src/envfile.ts';
import { createSanitizer, secretValues } from '../src/sanitize.ts';

const BASE = 'EMUCAT_ENVIRONMENT=test\nEMUCAT_BRANCH=develop\n';
const load = (text: string) =>
  loadDeployerConfig('/etc/emucat/deploy.env', () => parseEnvFile(text));

describe('host configuration', () => {
  it('disables browser updates unless explicitly enabled', () => {
    expect(load(BASE).updatesEnabled).toBe(false);
    expect(load(`${BASE}EMUCAT_ADMIN_UPDATES_ENABLED=yes`).updatesEnabled).toBe(false);
    expect(load(`${BASE}EMUCAT_ADMIN_UPDATES_ENABLED=TRUE`).updatesEnabled).toBe(false);
    expect(load(`${BASE}EMUCAT_ADMIN_UPDATES_ENABLED=true`).updatesEnabled).toBe(true);
  });

  it('uses fixed default paths and the loopback ingress for health checks', () => {
    const config = load(BASE);
    expect(config).toMatchObject({
      root: '/opt/emucat',
      ctlPath: '/opt/emucat/tooling/bin/emucatctl',
      socketPath: '/run/emucat-deployer/deployer.sock',
      healthUrl: 'http://127.0.0.1:8080/api/v1/ready',
    });
  });

  it.each([
    ['an option-like branch', 'EMUCAT_ENVIRONMENT=test\nEMUCAT_BRANCH=--force'],
    ['a ref expression', 'EMUCAT_ENVIRONMENT=test\nEMUCAT_BRANCH=main~1'],
    ['a traversal', 'EMUCAT_ENVIRONMENT=test\nEMUCAT_BRANCH=../main'],
    ['no branch', 'EMUCAT_ENVIRONMENT=test'],
    ['an odd environment', 'EMUCAT_ENVIRONMENT=Prod Uction\nEMUCAT_BRANCH=main'],
    ['a relative root', `${BASE}EMUCAT_ROOT=opt/emucat`],
    ['a hostname as bind address', `${BASE}EMUCAT_BIND_ADDRESS=example.com`],
  ])('rejects %s', (_label, text) => {
    expect(() => load(text)).toThrow(DeployerConfigError);
  });

  it('parses env files literally, without expansion', () => {
    const values = parseEnvFile('# comment\nA=$(id)\nB="quoted"\n bad line\nC=x=y\r\n');
    expect(values).toEqual(
      new Map([
        ['A', '$(id)'],
        ['B', '"quoted"'],
        ['C', 'x=y'],
      ]),
    );
  });
});

describe('sanitizer', () => {
  it('collects secret values by name from the application environment', () => {
    const values = parseEnvFile(
      'DB_PASSWORD=hunter2hunter2\nDB_USER=emucat-usr\nSETUP_TOKEN=abcdefgh\n',
    );
    expect(secretValues(values).sort()).toEqual(['abcdefgh', 'hunter2hunter2']);
  });

  it('removes literal secrets and common credential patterns', () => {
    const sanitize = createSanitizer(['hunter2hunter2']);
    expect(sanitize('connect password=hunter2hunter2 ok')).not.toContain('hunter2');
    expect(sanitize('MARIADB_PASSWORD: s3cret')).toBe('MARIADB_PASSWORD: [redacted]');
    expect(sanitize('git@github.com:owner/emucat.git')).toBe('git@github.com:owner/emucat.git');
    expect(sanitize('ssh://deploy:pw@host/x')).toBe('ssh://[redacted]@host/x');
    expect(sanitize('github_pat_11ABCDEFG0123456789_abcdefghijk')).toBe('[redacted]');
  });
});
