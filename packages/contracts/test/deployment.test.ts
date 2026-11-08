import { describe, expect, it } from 'vitest';
import {
  UPDATE_PROGRESS_STAGES,
  commitIdSchema,
  startUpdateRequestSchema,
  updateOperationPathParamsSchema,
} from '../src/index.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

describe('deployment contracts', () => {
  it('accepts only full, lowercase commit IDs', () => {
    expect(commitIdSchema.safeParse(COMMIT).success).toBe(true);
    for (const value of [
      COMMIT.slice(0, 12),
      COMMIT.toUpperCase(),
      'main',
      'refs/heads/main',
      'HEAD~1',
      `${COMMIT} `,
      `--upload-pack=${COMMIT}`,
    ]) {
      expect(commitIdSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('lets the browser send nothing but the commit it was shown', () => {
    expect(startUpdateRequestSchema.safeParse({ expectedCommit: COMMIT }).success).toBe(true);
    for (const extra of [
      { branch: 'main' },
      { ref: 'main' },
      { repositoryUrl: 'https://example.com/x.git' },
      { command: 'id' },
      { script: 'deploy.sh' },
    ]) {
      expect(startUpdateRequestSchema.safeParse({ expectedCommit: COMMIT, ...extra }).success).toBe(
        false,
      );
    }
    expect(startUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('names operations by UUID only', () => {
    expect(
      updateOperationPathParamsSchema.safeParse({
        operationId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7001',
      }).success,
    ).toBe(true);
    expect(updateOperationPathParamsSchema.safeParse({ operationId: '../../etc' }).success).toBe(
      false,
    );
  });

  it('shows progress in deployment order, ending with completion', () => {
    expect(UPDATE_PROGRESS_STAGES).toEqual([
      'checking_repository',
      'fetching_source',
      'building',
      'testing',
      'backing_up_database',
      'applying_migrations',
      'starting_services',
      'health_checking',
      'completed',
    ]);
  });
});
