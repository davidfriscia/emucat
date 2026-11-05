import { describe, expect, it } from 'vitest';
import {
  agentMessageSchema,
  agentNameSchema,
  agentSummarySchema,
  createPairingRequestSchema,
  discoveredVmSchema,
  discoveryResultPayloadSchema,
  discoverySkippedSchema,
  DISCOVERY_MAX_SKIPPED,
  DISCOVERY_MAX_VMS,
  formatPairingCode,
  hostCompatibility,
  normalizePairingCode,
  pairingPollResponseSchema,
  serverMessageSchema,
  type EmulatorType,
  type Platform,
} from '../src/index.js';
import { fixture } from './helpers.js';

const codes = fixture<{
  valid: { input: string; canonical: string; formatted: string }[];
  invalid: string[];
}>('pairing-codes');

const rules = fixture<{
  hostCompatibility: {
    emulator: EmulatorType;
    markers: string[];
    host: Platform;
    compatible: boolean | null;
  }[];
  skippedNames: { raw: string; display: string }[];
}>('discovery-rules');

const wire = fixture<Record<string, Record<string, unknown>>>('wire-examples');

const AGENT_ID = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f63';

describe('pairing codes', () => {
  it.each(codes.valid)('reads $input', ({ input, canonical, formatted }) => {
    expect(normalizePairingCode(input)).toBe(canonical);
    expect(formatPairingCode(canonical)).toBe(formatted);
  });

  it.each(codes.invalid)('refuses %j', (input) => {
    expect(normalizePairingCode(input)).toBeNull();
  });
});

describe('agent names', () => {
  it('trims and accepts ordinary names, including non-ASCII ones', () => {
    expect(agentNameSchema.parse('  Desk PC  ')).toBe('Desk PC');
    expect(agentNameSchema.parse('Büro')).toBe('Büro');
  });

  it.each(['', '   ', 'a\nb', 'a\u0000b', 'x'.repeat(129)])('refuses %j', (name) => {
    expect(agentNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('pairing messages', () => {
  const request = {
    name: 'Desk',
    platform: 'windows',
    architecture: 'x86_64',
    agentVersion: '0.1.0',
    protocolVersion: 1,
  };

  it('accepts a request, and nothing beyond it', () => {
    expect(createPairingRequestSchema.safeParse(request).success).toBe(true);
    expect(createPairingRequestSchema.safeParse({ ...request, agentId: AGENT_ID }).success).toBe(
      false,
    );
    expect(createPairingRequestSchema.safeParse({ ...request, platform: 'plan9' }).success).toBe(
      false,
    );
    expect(createPairingRequestSchema.safeParse({ ...request, agentVersion: 'a b' }).success).toBe(
      false,
    );
  });

  it('delivers a credential only with an approval', () => {
    expect(
      pairingPollResponseSchema.safeParse({
        status: 'approved',
        agentId: AGENT_ID,
        credential: 'x',
      }).success,
    ).toBe(true);
    expect(pairingPollResponseSchema.parse({ status: 'rejected', credential: 'x' })).toEqual({
      status: 'rejected',
    });
  });

  it('has no place for a credential or a digest in what an administrator reads', () => {
    const fields = Object.keys(agentSummarySchema.shape).join(' ').toLowerCase();
    expect(fields).not.toMatch(/credential|secret|hash|token/);
  });
});

describe('host compatibility', () => {
  it.each(rules.hostCompatibility)(
    '$emulator $markers on $host',
    ({ emulator, markers, host, compatible }) => {
      expect(hostCompatibility(emulator, markers, host)).toBe(compatible);
    },
  );
});

describe('discovery reports', () => {
  const vm = {
    emulatorType: 'qemu',
    vmName: 'Win98',
    markers: ['run-win.cmd'],
    hostCompatible: true,
  };
  const report = {
    operationId: AGENT_ID,
    hostPlatform: 'windows',
    emulators: [{ emulatorType: 'qemu', status: 'ok', truncated: false }],
    vms: [vm],
    skipped: [],
  };
  const parses = (value: unknown) => discoveryResultPayloadSchema.safeParse(value).success;

  it('accepts the shared examples', () => {
    expect(serverMessageSchema.safeParse(wire.serverDiscoveryRequest).success).toBe(true);
    expect(serverMessageSchema.safeParse(wire.serverHeartbeatAck).success).toBe(true);
    expect(agentMessageSchema.safeParse(wire.agentDiscoveryResult).success).toBe(true);
    expect(agentMessageSchema.safeParse(wire.agentDiscoveryError).success).toBe(true);
    expect(parses(report)).toBe(true);
  });

  it('applies the VM name rules', () => {
    for (const vmName of ['../evil', 'C:', '-rf', 'Win98_202601311530', 'con']) {
      expect(parses({ ...report, vms: [{ ...vm, vmName }] }), vmName).toBe(false);
    }
  });

  it('accepts only markers of the VM’s own emulator', () => {
    expect(discoveredVmSchema.safeParse({ ...vm, markers: ['86box.cfg'] }).success).toBe(false);
    expect(discoveredVmSchema.safeParse({ ...vm, markers: ['evil.exe'] }).success).toBe(false);
    expect(discoveredVmSchema.safeParse({ ...vm, markers: [] }).success).toBe(false);
    expect(
      discoveredVmSchema.safeParse({ ...vm, markers: ['run-win.cmd', 'run-win.cmd'] }).success,
    ).toBe(false);
  });

  it('refuses one identity reported twice, whatever its case', () => {
    expect(parses({ ...report, vms: [vm, { ...vm, vmName: 'WIN98' }] })).toBe(false);
  });

  it('drops any claim of identity', () => {
    const parsed = discoveryResultPayloadSchema.parse({ ...report, agentId: AGENT_ID });
    expect(parsed).not.toHaveProperty('agentId');
  });

  it('bounds its size', () => {
    const vms = Array.from({ length: DISCOVERY_MAX_VMS + 1 }, (_, index) => ({
      ...vm,
      vmName: `Vm${index}`,
    }));
    expect(parses({ ...report, vms })).toBe(false);
    const skipped = Array.from({ length: DISCOVERY_MAX_SKIPPED + 1 }, () => ({
      emulatorType: 'qemu',
      name: 'x',
      reason: 'missing_marker',
      nameError: null,
    }));
    expect(parses({ ...report, skipped })).toBe(false);
  });

  it.each(rules.skippedNames)('allows the reported form of $raw', ({ display }) => {
    expect(
      discoverySkippedSchema.safeParse({
        emulatorType: 'qemu',
        name: display,
        reason: 'invalid_name',
        nameError: 'invalid_characters',
      }).success,
    ).toBe(true);
  });

  it('refuses a skipped name that was not made safe', () => {
    for (const name of ['café', 'a\nb', 'x'.repeat(81)]) {
      expect(
        discoverySkippedSchema.safeParse({
          emulatorType: 'qemu',
          name,
          reason: 'invalid_name',
          nameError: null,
        }).success,
        name,
      ).toBe(false);
    }
  });

  it('refuses a discovery request with anything extra, and an unknown reason', () => {
    const request = wire.serverDiscoveryRequest as { payload: object };
    expect(
      serverMessageSchema.safeParse({
        ...request,
        payload: { ...request.payload, path: 'C:\\' },
      }).success,
    ).toBe(false);
    expect(
      discoverySkippedSchema.safeParse({
        emulatorType: 'qemu',
        name: 'x',
        reason: 'because',
        nameError: null,
      }).success,
    ).toBe(false);
  });
});
