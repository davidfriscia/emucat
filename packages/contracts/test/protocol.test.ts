import { describe, expect, it } from 'vitest';
import {
  RESTORE_ERROR_CODES,
  agentMessageSchema,
  agentVmStateSchema,
  envelopeSchema,
  isLocalContentTrusted,
  isRestoreCancellable,
  isRestoreTerminal,
  restoreRecovery,
  serverMessageSchema,
} from '../src/index.js';
import { fixture } from './helpers.js';

const wire = fixture<Record<string, Record<string, unknown>>>('wire-examples');

describe('protocol messages', () => {
  it('accepts the shared examples', () => {
    expect(agentMessageSchema.safeParse(wire.agentHello).success).toBe(true);
    expect(agentMessageSchema.safeParse(wire.agentHeartbeat).success).toBe(true);
    expect(serverMessageSchema.safeParse(wire.serverWelcome).success).toBe(true);
    expect(serverMessageSchema.safeParse(wire.serverError).success).toBe(true);
  });

  it('requires version, id and timestamp on the envelope', () => {
    for (const field of ['protocolVersion', 'id', 'sentAt', 'type']) {
      const message = { ...wire.agentHello };
      delete message[field];
      expect(envelopeSchema.safeParse(message).success, field).toBe(false);
    }
  });

  it('does not accept server messages or commands from an agent', () => {
    expect(agentMessageSchema.safeParse(wire.serverWelcome).success).toBe(false);
    expect(agentMessageSchema.safeParse({ ...wire.agentHello, type: 'vm.launch' }).success).toBe(
      false,
    );
  });
});

describe('agent VM state', () => {
  it('accepts the shared example', () => {
    expect(agentVmStateSchema.safeParse(wire.agentVmState).success).toBe(true);
  });

  it('rejects an unknown execution state', () => {
    expect(
      agentVmStateSchema.safeParse({ ...wire.agentVmState, executionState: 'paused' }).success,
    ).toBe(false);
  });

  const connectedAt = '2026-02-01T00:00:00Z';

  it('does not trust a verification from before the last connection', () => {
    expect(
      isLocalContentTrusted(
        { contentStatus: 'verified', lastVerifiedAt: '2026-01-31T00:00:00Z' },
        connectedAt,
      ),
    ).toBe(false);
  });

  it('trusts a verification made since the last connection', () => {
    expect(
      isLocalContentTrusted(
        { contentStatus: 'verified', lastVerifiedAt: '2026-02-01T00:00:01Z' },
        connectedAt,
      ),
    ).toBe(true);
  });

  it.each(['unverified', 'modified'] as const)('does not trust %s content', (contentStatus) => {
    expect(
      isLocalContentTrusted({ contentStatus, lastVerifiedAt: '2026-02-01T00:00:01Z' }, connectedAt),
    ).toBe(false);
  });
});

const registration =
  fixture<
    Record<
      'registrationServerMessages' | 'registrationAgentMessages' | 'registrationRefusedByTheAgent',
      { type: string }[]
    >
  >('wire-examples');

describe('registration messages', () => {
  it('accepts the shared examples', () => {
    for (const message of registration.registrationServerMessages) {
      expect(serverMessageSchema.safeParse(message).success, message.type).toBe(true);
    }
    for (const message of registration.registrationAgentMessages) {
      expect(agentMessageSchema.safeParse(message).success, message.type).toBe(true);
    }
  });

  it('refuses a command that adds a path, an unsafe VM name or an unknown mode', () => {
    for (const message of registration.registrationRefusedByTheAgent) {
      expect(serverMessageSchema.safeParse(message).success).toBe(false);
    }
  });

  it('never carries archive bytes: a result is metadata only', () => {
    const result = registration.registrationAgentMessages.find(
      (message) => message.type === 'agent.registration_result',
    );
    expect(JSON.stringify(result).length).toBeLessThan(1024);
  });
});

describe('screenshot messages', () => {
  it('accepts a status report, and refuses one that says too much', () => {
    expect(agentMessageSchema.safeParse(wire.agentMediaSyncStatus).success).toBe(true);
    const status = wire.agentMediaSyncStatus as { payload: { vms: unknown[] } };
    const many = {
      ...status,
      payload: { ...status.payload, vms: Array.from({ length: 101 }, () => status.payload.vms[0]) },
    };
    expect(agentMessageSchema.safeParse(many).success).toBe(false);
  });

  it('asks for a retried removal with identities only', () => {
    const retry = {
      protocolVersion: 1,
      id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6020',
      sentAt: '2026-01-31T15:30:00Z',
      type: 'server.registration_retry_cleanup',
      payload: {
        operationId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6100',
        versionId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6101',
      },
    };
    expect(serverMessageSchema.safeParse(retry).success).toBe(true);
    const withPath = { ...retry, payload: { ...retry.payload, path: 'C:/Windows' } };
    expect(serverMessageSchema.safeParse(withPath).success).toBe(false);
  });
});

describe('restore messages', () => {
  const all = fixture<Record<string, unknown[]>>('wire-examples');

  it('accepts the shared examples, each in the right direction', () => {
    for (const example of all.restoreServerMessages ?? []) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(agentMessageSchema.safeParse(example).success).toBe(false);
    }
    for (const example of all.restoreAgentMessages ?? []) {
      expect(agentMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(serverMessageSchema.safeParse(example).success).toBe(false);
    }
  });

  it('refuses a command that tries to say where something goes', () => {
    for (const example of all.restoreRefusedByTheAgent ?? []) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(false);
    }
  });
});

describe('restore states', () => {
  it('knows when a restore can be cancelled, and when it has ended', () => {
    expect(isRestoreCancellable('downloading')).toBe(true);
    expect(isRestoreCancellable('publishing_local')).toBe(false);
    expect(isRestoreCancellable('committing')).toBe(false);
    expect(isRestoreCancellable('succeeded')).toBe(false);
    expect(isRestoreTerminal('partial_success')).toBe(true);
    expect(isRestoreTerminal('committing')).toBe(false);
  });

  it('has recovery advice for each of its codes that an administrator can act on', () => {
    for (const code of RESTORE_ERROR_CODES) {
      if (code === 'internal_error') continue;
      expect(restoreRecovery(code), code).not.toBeNull();
    }
    expect(restoreRecovery('some_code_from_a_newer_agent')).toBeNull();
  });
});
