import { describe, expect, it } from 'vitest';
import {
  REGISTRATION_STATES,
  decodeRegistrationCursor,
  discoveryOperationSchema,
  encodeRegistrationCursor,
  registrationListQuerySchema,
  registrationListResponseSchema,
  registrationNeedsAttention,
  registrationOperationSchema,
  registrationVersionKind,
  type RegistrationState,
} from '../src/index.js';

const CURSOR = {
  createdAt: '2026-11-10T21:27:52.123Z',
  id: '71715230-df66-4227-9bd9-6713a95c6196',
};

describe('registration listing queries', () => {
  it('default to every operation, a hundred at a time, as before', () => {
    expect(registrationListQuerySchema.parse({})).toEqual({ view: 'all', limit: 100 });
    expect(
      registrationListQuerySchema.parse({ agentId: '1a8acacf-46fc-4468-8a69-3af6c1ea7db0' }),
    ).toMatchObject({ view: 'all', limit: 100 });
  });

  it('take every filter, as a query string carries it', () => {
    const parsed = registrationListQuerySchema.parse({
      view: 'history',
      emulatorType: '86box',
      vmName: '486-dos622ita',
      q: '  dos  ',
      mode: 'snapshot',
      state: 'failed,cancelled',
      createdFrom: '2026-11-01T00:00:00.000Z',
      createdBefore: '2026-11-12T00:00:00.000Z',
      cursor: encodeRegistrationCursor(CURSOR),
      limit: '25',
    });
    expect(parsed).toMatchObject({
      view: 'history',
      q: 'dos',
      state: ['failed', 'cancelled'],
      cursor: CURSOR,
      limit: 25,
    });
  });

  it.each([
    [{ view: 'archive' }],
    [{ limit: '0' }],
    [{ limit: '101' }],
    [{ limit: '2.5' }],
    [{ state: 'failed,unknown' }],
    [{ state: '' }],
    [{ state: REGISTRATION_STATES.concat(REGISTRATION_STATES).join(',') }],
    [{ vmName: '../x' }],
    [{ q: '' }],
    [{ q: 'x'.repeat(65) }],
    [{ createdFrom: 'last week' }],
    [{ createdFrom: '2026-11-12T00:00:00Z', createdBefore: '2026-11-12T00:00:00Z' }],
    [{ cursor: 'not a cursor' }],
    [{ cursor: 'e30' }],
    [{ repositoryRoot: '/srv' }],
  ])('refuse %j', (query) => {
    expect(registrationListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('registration cursors', () => {
  it('round-trip, and are URL-safe', () => {
    const encoded = encodeRegistrationCursor(CURSOR);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRegistrationCursor(encoded)).toEqual(CURSOR);
  });

  it.each([
    '',
    '!!!',
    btoa('[]'),
    btoa('["2026-11-10T21:27:52Z"]'),
    btoa('["yesterday","71715230-df66-4227-9bd9-6713a95c6196"]'),
    btoa('["2026-11-10T21:27:52Z","not-a-uuid"]'),
    btoa('{"createdAt":"2026-11-10T21:27:52Z","id":"71715230-df66-4227-9bd9-6713a95c6196"}'),
  ])('reject anything this API did not issue: %j', (text) => {
    expect(decodeRegistrationCursor(text)).toBeNull();
  });
});

function operation(state: RegistrationState, overrides: object = {}) {
  return registrationOperationSchema.parse({
    id: '71715230-df66-4227-9bd9-6713a95c6196',
    agentId: '1a8acacf-46fc-4468-8a69-3af6c1ea7db0',
    agentName: 'MARS',
    agentOnline: true,
    repositoryId: 'a564b84d-6019-44de-a6c3-354bf333ab20',
    repositoryName: 'My Storage',
    emulatorType: '86box',
    vmName: '486-dos622ita',
    mode: 'copy',
    state,
    versionId: 'b564b84d-6019-44de-a6c3-354bf333ab20',
    parentVersionId: null,
    snapshotName: null,
    workspaceId: null,
    archiveKey: 'vms/86box/486-dos622ita/x.zip',
    progress: { doneBytes: null, totalBytes: null },
    archive: null,
    localCopy: null,
    error: null,
    recovery: null,
    cancelRequested: false,
    requestedByDisplayName: null,
    createdAt: '2026-11-10T21:27:52.000Z',
    updatedAt: '2026-11-10T21:27:52.000Z',
    committedAt: null,
    finishedAt: null,
    ...overrides,
  });
}

describe('registration operations', () => {
  it('parse a response from before the history fields existed', () => {
    const parsed = operation('succeeded');
    expect(parsed).toMatchObject({
      acknowledgedAt: null,
      acknowledgedByDisplayName: null,
      parentSnapshotName: null,
      versionDeletion: null,
    });
    expect(registrationListResponseSchema.parse({ operations: [parsed] })).toMatchObject({
      nextCursor: null,
    });
  });

  it('need attention while they run, or after a partial success nobody has acknowledged', () => {
    const needs = (state: RegistrationState, acknowledgedAt: string | null = null) =>
      registrationNeedsAttention({ state, acknowledgedAt });
    for (const state of [
      'queued',
      'validating',
      'archiving',
      'uploading',
      'verifying',
      'committing',
      'cleaning_local',
    ] as const) {
      expect(needs(state), state).toBe(true);
    }
    expect(needs('partial_success')).toBe(true);
    expect(needs('partial_success', '2026-11-12T00:00:00.000Z')).toBe(false);
    // A failure or cancellation committed nothing and left the local VM as it was.
    expect(needs('failed')).toBe(false);
    expect(needs('cancelled')).toBe(false);
    expect(needs('succeeded')).toBe(false);
  });

  it('say which kind of version they produce', () => {
    expect(registrationVersionKind('copy')).toBe('master');
    expect(registrationVersionKind('transfer')).toBe('master');
    expect(registrationVersionKind('snapshot')).toBe('snapshot');
  });

  it('carry a deleted version as history, not as an error', () => {
    expect(operation('succeeded', { versionDeletion: 'deleted' }).versionDeletion).toBe('deleted');
    expect(() => operation('succeeded', { versionDeletion: 'gone' })).toThrow();
  });
});

describe('discovery reports', () => {
  it('parse without the freshness fields, as an older server sent them', () => {
    const parsed = discoveryOperationSchema.parse({
      id: '71715230-df66-4227-9bd9-6713a95c6196',
      agentId: '1a8acacf-46fc-4468-8a69-3af6c1ea7db0',
      status: 'completed',
      startedAt: '2026-11-10T21:27:52.000Z',
      finishedAt: '2026-11-10T21:27:53.000Z',
      failure: null,
      hostPlatform: 'windows',
      emulators: [],
      vms: [],
      skipped: [],
    });
    expect(parsed).toMatchObject({ expiresAt: null, fromCurrentConnection: true });
  });
});
