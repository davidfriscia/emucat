import { describe, expect, it } from 'vitest';
import {
  agentMessageSchema,
  agentVmStateSchema,
  envelopeSchema,
  isLocalContentTrusted,
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
