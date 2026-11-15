import { describe, expect, it } from 'vitest';
import {
  agentMessageSchema,
  archiveFormatFor,
  archiveObjectKey,
  createRegistrationRequestSchema,
  EMULATOR_TYPES,
  executionOptionsResponseSchema,
  FILESYSTEM_EMULATOR_TYPES,
  filesystemEmulatorTypeSchema,
  isVirtualBoxActive,
  registrationSyncPayloadSchema,
  serverMessageSchema,
  VIRTUALBOX_ACTIVE_POLL_SECONDS,
  VIRTUALBOX_ENDED_STATES,
  VIRTUALBOX_INACTIVE_POLL_SECONDS,
  virtualBoxObservationSchema,
  virtualBoxWatchPayloadSchema,
  VIRTUALBOX_WATCH_MAX,
} from '../src/index.js';
import { fixture } from './helpers.js';

type Example = { type: string; payload: Record<string, unknown> };
const all = fixture<Record<string, Example[] | undefined>>('wire-examples');

const MACHINE = '2acda0fc-cea6-406b-8a55-746fac380687';
const request = {
  agentId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7001',
  repositoryId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7002',
  emulatorType: 'virtualbox',
  vmName: 'xenix-386',
  mode: 'copy',
  discoveryOperationId: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e7003',
  virtualboxUuid: MACHINE,
};

describe('VirtualBox messages', () => {
  it('accepts each one in its own direction only', () => {
    for (const example of all.virtualboxServerMessages ?? []) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(agentMessageSchema.safeParse(example).success).toBe(false);
    }
    for (const example of all.virtualboxAgentMessages ?? []) {
      expect(agentMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
      expect(serverMessageSchema.safeParse(example).success).toBe(false);
    }
    expect(all.virtualboxServerMessages?.length).toBeGreaterThan(0);
    expect(all.virtualboxAgentMessages?.length).toBeGreaterThan(0);
  });

  it('refuses a path, a name for a UUID, an unknown action, and a VirtualBox VM where a directory is read', () => {
    for (const example of all.virtualboxRefusedByTheAgent ?? []) {
      expect(serverMessageSchema.safeParse(example).success, JSON.stringify(example)).toBe(false);
    }
    expect(all.virtualboxRefusedByTheAgent?.length).toBeGreaterThan(0);
  });

  it('reads the sync of an agent that predates VirtualBox as not capable', () => {
    const parsed = registrationSyncPayloadSchema.parse({ operations: [], snapshots: true });
    expect(parsed.virtualbox).toBeUndefined();
  });

  it('bounds a watch', () => {
    const machines = Array.from(
      { length: VIRTUALBOX_WATCH_MAX + 1 },
      (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );
    expect(virtualBoxWatchPayloadSchema.safeParse({ machines }).success).toBe(false);
    expect(virtualBoxWatchPayloadSchema.safeParse({ machines: machines.slice(1) }).success).toBe(
      true,
    );
  });

  it('keeps a state a newer agent knows and this does not as unknown', () => {
    const observation = virtualBoxObservationSchema.parse({
      machineUuid: MACHINE,
      present: true,
      name: 'Xenix 386',
      state: 'teleporting_somewhere',
      rawState: 'whatever',
      stateChangedAt: null,
      accessible: true,
      observedAt: '2026-01-31T15:30:00Z',
    });
    expect(observation.state).toBe('unknown');
  });
});

describe('VirtualBox polling', () => {
  it('uses the intervals the specification names', () => {
    expect(VIRTUALBOX_ACTIVE_POLL_SECONDS).toBe(15);
    expect(VIRTUALBOX_INACTIVE_POLL_SECONDS).toBe(60);
  });

  it('counts a machine with a VM process as active, and only that', () => {
    for (const state of ['running', 'paused', 'starting', 'stopping', 'stuck'] as const) {
      expect(isVirtualBoxActive(state)).toBe(true);
    }
    for (const state of [...VIRTUALBOX_ENDED_STATES, 'busy', 'inaccessible', 'unknown'] as const) {
      expect(isVirtualBoxActive(state)).toBe(false);
    }
  });
});

describe('VirtualBox masters', () => {
  it('is a catalog type, and never one whose VMs are directories', () => {
    expect(EMULATOR_TYPES).toContain('virtualbox');
    expect(FILESYSTEM_EMULATOR_TYPES).not.toContain('virtualbox');
    expect(filesystemEmulatorTypeSchema.safeParse('virtualbox').success).toBe(false);
  });

  it('keeps its master as an OVA, under its own type', () => {
    const versionId = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e6601';
    expect(archiveFormatFor('virtualbox')).toBe('ova');
    expect(archiveFormatFor('qemu')).toBe('zip');
    expect(archiveObjectKey({ emulatorType: 'virtualbox', vmName: 'Xenix-386' }, versionId)).toBe(
      `archives/virtualbox/xenix-386/${versionId}.ova`,
    );
    // Unchanged for the others.
    expect(archiveObjectKey({ emulatorType: '86box', vmName: 'Win98' }, versionId)).toBe(
      `archives/86box/win98/${versionId}.zip`,
    );
  });

  it('registers a machine by its UUID, as a copy only', () => {
    expect(createRegistrationRequestSchema.safeParse(request).success).toBe(true);
    const withoutMachine: Partial<typeof request> = { ...request };
    delete withoutMachine.virtualboxUuid;
    expect(createRegistrationRequestSchema.safeParse(withoutMachine).success).toBe(false);
    expect(
      createRegistrationRequestSchema.safeParse({
        ...request,
        mode: 'transfer',
        confirmDestructive: true,
      }).success,
    ).toBe(false);
    expect(
      createRegistrationRequestSchema.safeParse({ ...request, virtualboxUuid: 'Xenix 386' })
        .success,
    ).toBe(false);
    // A machine for anything else is refused too.
    expect(
      createRegistrationRequestSchema.safeParse({ ...request, emulatorType: 'qemu' }).success,
    ).toBe(false);
  });

  it('defaults the execution options of an older server to no VirtualBox source', () => {
    const parsed = executionOptionsResponseSchema.parse({ modes: [], agents: [] });
    expect(parsed.virtualbox).toBeNull();
  });
});
