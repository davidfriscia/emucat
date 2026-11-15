import { describe, expect, it } from 'vitest';
import {
  agentMessageSchema,
  discoveryOperationSchema,
  discoveryResultPayloadSchema,
  virtualBoxDiscoverySchema,
  virtualBoxVmSchema,
  VIRTUALBOX_MAX_VMS,
  type VirtualBoxVm,
} from '../src/index.js';
import { fixture } from './helpers.js';

const wire = fixture<Record<string, { payload: Record<string, unknown> }>>('wire-examples');
const withVirtualBox = wire.agentDiscoveryResultWithVirtualBox!;
const filesystemOnly = wire.agentDiscoveryResult!;

const machine = (overrides: Partial<Record<keyof VirtualBoxVm, unknown>> = {}) => ({
  uuid: '2acda0fc-cea6-406b-8a55-746fac380687',
  name: 'Xenix 386',
  osType: 'Other/Unknown',
  state: 'powered_off',
  rawState: 'poweroff',
  stateChangedAt: '2025-07-18T05:33:15Z',
  accessible: true,
  memoryMb: 4,
  cpus: 1,
  error: null,
  ...overrides,
});

const uuidFor = (index: number) =>
  `2acda0fc-cea6-406b-8a55-${index.toString(16).padStart(12, '0')}`;

describe('VirtualBox discovery', () => {
  it('accepts the shared example, as an agent message', () => {
    expect(agentMessageSchema.safeParse(withVirtualBox).success).toBe(true);
    const parsed = discoveryResultPayloadSchema.parse(withVirtualBox.payload);
    expect(parsed.virtualbox?.status).toBe('ok');
    expect(parsed.virtualbox?.vms.map((vm) => vm.state)).toEqual([
      'powered_off',
      'running',
      'inaccessible',
      'unknown',
    ]);
    expect(parsed.virtualbox?.vms[1]?.name).toBe('Città "Ufficio" {v2}');
    // The filesystem part is exactly what it was.
    expect(parsed.vms).toEqual(withVirtualBox.payload.vms);
  });

  it('accepts a report from an agent that predates VirtualBox', () => {
    const parsed = discoveryResultPayloadSchema.parse(filesystemOnly.payload);
    expect(parsed.virtualbox).toBeUndefined();
    expect(parsed.vms).toHaveLength(2);
  });

  it.each([
    ['an invalid UUID', { uuid: 'not-a-uuid' }],
    ['an uppercase UUID', { uuid: '2ACDA0FC-CEA6-406B-8A55-746FAC380687' }],
    ['a braced UUID', { uuid: '{2acda0fc-cea6-406b-8a55-746fac380687}' }],
    ['a name that is too long', { name: 'x'.repeat(257) }],
    ['a name with a control character', { name: 'a\nb' }],
    ['a raw state with spaces', { rawState: 'power off' }],
    ['a time without a zone', { stateChangedAt: '2025-07-18T05:33:15' }],
    ['a negative memory size', { memoryMb: -1 }],
  ])('refuses a machine with %s', (_label, overrides) => {
    expect(virtualBoxVmSchema.safeParse(machine(overrides)).success).toBe(false);
  });

  it('accepts any Unicode name within the limit', () => {
    expect(virtualBoxVmSchema.safeParse(machine({ name: 'ü'.repeat(128) })).success).toBe(true);
    expect(virtualBoxVmSchema.safeParse(machine({ name: '日本語 / "quoted" {x}' })).success).toBe(
      true,
    );
  });

  it('reads a state or error it does not know as unknown, and keeps the machine', () => {
    const parsed = virtualBoxVmSchema.parse(
      machine({ state: 'hyperspace', rawState: 'hyperspace', error: 'gremlins' }),
    );
    expect(parsed.state).toBe('unknown');
    expect(parsed.rawState).toBe('hyperspace');
    expect(parsed.error).toBe('inspection_failed');
  });

  it('refuses more machines than the limit, and repeated UUIDs', () => {
    const many = Array.from({ length: VIRTUALBOX_MAX_VMS + 1 }, (_, index) =>
      machine({ uuid: uuidFor(index) }),
    );
    const report = { status: 'ok', version: '7.1.10r169112', truncated: false };
    expect(virtualBoxDiscoverySchema.safeParse({ ...report, vms: many }).success).toBe(false);
    expect(
      virtualBoxDiscoverySchema.safeParse({ ...report, vms: many.slice(0, VIRTUALBOX_MAX_VMS) })
        .success,
    ).toBe(true);
    expect(
      virtualBoxDiscoverySchema.safeParse({ ...report, vms: [machine(), machine()] }).success,
    ).toBe(false);
  });

  it('refuses a version that is not one', () => {
    for (const version of ['', '7.1 beta', 'x'.repeat(65), 'C:\\VirtualBox']) {
      expect(
        virtualBoxDiscoverySchema.safeParse({ status: 'ok', version, truncated: false, vms: [] })
          .success,
        version,
      ).toBe(false);
    }
  });

  it('never lets a bad VirtualBox part cost the 86Box and QEMU results', () => {
    const payload = {
      ...withVirtualBox.payload,
      virtualbox: { status: 'ok', version: '7.1', truncated: false, vms: [machine({ uuid: 'x' })] },
    };
    const parsed = discoveryResultPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.virtualbox?.status).toBe('invalid_report');
    expect(parsed.data?.virtualbox?.vms).toEqual([]);
    expect(parsed.data?.vms).toEqual(withVirtualBox.payload.vms);

    const unknownStatus = { ...withVirtualBox.payload, virtualbox: { status: 'exploded' } };
    expect(discoveryResultPayloadSchema.parse(unknownStatus).virtualbox?.status).toBe(
      'invalid_report',
    );
  });

  it('drops anything a machine says beyond its fields, such as a path', () => {
    const parsed = virtualBoxVmSchema.parse({ ...machine(), cfgFile: 'C:\\VMs\\x.vbox' });
    expect(parsed).not.toHaveProperty('cfgFile');
  });

  it('reads an operation without a VirtualBox part, as an older server sends it', () => {
    const operation = discoveryOperationSchema.parse({
      id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f6b',
      agentId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f63',
      status: 'completed',
      startedAt: '2026-01-31T15:30:00Z',
      finishedAt: '2026-01-31T15:30:02Z',
      failure: null,
      hostPlatform: 'windows',
      emulators: [],
      vms: [],
      skipped: [],
    });
    expect(operation.virtualbox).toBeNull();
  });
});
