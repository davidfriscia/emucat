import { z } from 'zod';
import {
  filesystemEmulatorTypeSchema,
  VM_ROOT_MARKERS,
  type FilesystemEmulatorType,
} from './emulator.js';
import { platformSchema, type Platform } from './platform.js';
import { timestampSchema } from './version.js';
import { VM_NAME_ERROR_CODES, vmNameKey, vmNameSchema } from './vm-name.js';

/** Limits on one report. With these, a report always fits in one protocol message. */
export const DISCOVERY_MAX_VMS = 256;
export const DISCOVERY_MAX_SKIPPED = 64;
export const DISCOVERY_SKIPPED_NAME_MAX_LENGTH = 80;

/**
 * The launch scripts each host can run. Scripts are reported, and never executed by discovery or
 * registration. `.bat` and `.cmd` files are Windows scripts, whatever else their name says.
 */
export const QEMU_HOST_LAUNCH_SCRIPTS: Readonly<Record<Platform, readonly string[]>> = {
  windows: ['run.bat', 'run.cmd', 'run-win.bat', 'run-win.cmd'],
  macos: ['run-mac.sh'],
  linux: ['run-linux.sh'],
};

/**
 * Whether a VM has a launch script for this host. Only QEMU has a notion of this, so 86Box is `null`.
 * The agent implements the same rule, and both are tested against `fixtures/discovery-rules.json`.
 */
export function hostCompatibility(
  emulatorType: FilesystemEmulatorType,
  markers: readonly string[],
  host: Platform,
): boolean | null {
  if (emulatorType !== 'qemu') return null;
  const scripts = QEMU_HOST_LAUNCH_SCRIPTS[host];
  return markers.some((marker) => scripts.includes(marker));
}

export const DISCOVERY_EMULATOR_STATUSES = [
  'ok',
  'not_configured',
  'base_path_missing',
  'base_path_not_directory',
  'base_path_inaccessible',
] as const;
export const discoveryEmulatorStatusSchema = z.enum(DISCOVERY_EMULATOR_STATUSES);
export type DiscoveryEmulatorStatus = z.infer<typeof discoveryEmulatorStatusSchema>;

export const DISCOVERY_SKIP_REASONS = [
  'invalid_name',
  'missing_marker',
  'marker_wrong_case',
  'reparse_point',
  'not_accessible',
  'vanished',
  'duplicate_identity',
  'too_many_entries',
] as const;
export const discoverySkipReasonSchema = z.enum(DISCOVERY_SKIP_REASONS);
export type DiscoverySkipReason = z.infer<typeof discoverySkipReasonSchema>;

export const discoveredVmSchema = z
  .object({
    emulatorType: filesystemEmulatorTypeSchema,
    vmName: vmNameSchema,
    /** The markers present, as regular files, in the VM's root. */
    markers: z.array(z.string().max(32)).min(1).max(6),
    hostCompatible: z.boolean().nullable(),
  })
  .superRefine((vm, context) => {
    const known = VM_ROOT_MARKERS[vm.emulatorType];
    if (vm.markers.some((marker) => !known.includes(marker))) {
      context.addIssue({ code: 'custom', message: 'Not a marker of this emulator' });
    }
    if (new Set(vm.markers).size !== vm.markers.length) {
      context.addIssue({ code: 'custom', message: 'Repeated marker' });
    }
  });
export type DiscoveredVm = z.infer<typeof discoveredVmSchema>;

export const discoverySkippedSchema = z.object({
  emulatorType: filesystemEmulatorTypeSchema,
  /** The directory's name, for display only. Reduced to printable ASCII and bounded in length. */
  name: z
    .string()
    .max(DISCOVERY_SKIPPED_NAME_MAX_LENGTH)
    .regex(/^[\x20-\x7e]*$/),
  reason: discoverySkipReasonSchema,
  nameError: z.enum(VM_NAME_ERROR_CODES).nullable(),
});
export type DiscoverySkipped = z.infer<typeof discoverySkippedSchema>;

export const discoveryEmulatorReportSchema = z.object({
  emulatorType: filesystemEmulatorTypeSchema,
  status: discoveryEmulatorStatusSchema,
  /** Some entries were not examined or not reported, because a limit was reached. */
  truncated: z.boolean(),
});
export type DiscoveryEmulatorReport = z.infer<typeof discoveryEmulatorReportSchema>;

// VirtualBox, which keeps its own list of machines. See decision 0044.

/** Limits on the VirtualBox part of one report. Mirrored by the agent. */
export const VIRTUALBOX_MAX_VMS = 128;
/** In UTF-16 code units. The agent cuts names to 128 characters, which is never more than this. */
export const VIRTUALBOX_NAME_MAX_LENGTH = 256;
export const VIRTUALBOX_OS_TYPE_MAX_LENGTH = 128;
export const VIRTUALBOX_RAW_STATE_MAX_LENGTH = 32;
export const VIRTUALBOX_VERSION_MAX_LENGTH = 64;

export const VIRTUALBOX_DISCOVERY_STATUSES = [
  'ok',
  'not_configured',
  'executable_missing',
  'unrecognized_version',
  'unrecognized_output',
  'command_failed',
  'timeout',
  /** Assigned by the server, never sent: the agent sent a VirtualBox part that failed validation. */
  'invalid_report',
] as const;
export const virtualBoxDiscoveryStatusSchema = z.enum(VIRTUALBOX_DISCOVERY_STATUSES);
export type VirtualBoxDiscoveryStatus = z.infer<typeof virtualBoxDiscoveryStatusSchema>;

/**
 * A machine's state, grouped into what EmuCat tells apart. A state this version does not know reads
 * as `unknown`, so that a newer agent never costs a report its other machines.
 */
export const VIRTUALBOX_VM_STATES = [
  'powered_off',
  'running',
  'paused',
  'saved',
  'starting',
  'stopping',
  'aborted',
  'stuck',
  'busy',
  'inaccessible',
  'unknown',
] as const;
export const virtualBoxVmStateSchema = z.enum(VIRTUALBOX_VM_STATES);
export type VirtualBoxVmState = z.infer<typeof virtualBoxVmStateSchema>;

export const VIRTUALBOX_VM_ERRORS = [
  'inspection_failed',
  'timeout',
  'vanished',
  'not_inspected',
] as const;
export const virtualBoxVmErrorSchema = z.enum(VIRTUALBOX_VM_ERRORS);
export type VirtualBoxVmError = z.infer<typeof virtualBoxVmErrorSchema>;

/** Display text from VirtualBox: anything but control characters, bounded. */
const virtualBoxText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^\P{Cc}*$/u);

/** VirtualBox's own identity for a machine, lowercase and hyphenated. Any UUID version. */
export const virtualBoxUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const virtualBoxVmSchema = z.object({
  uuid: virtualBoxUuidSchema,
  /** For display only. Never used to name the machine in a command, and never a catalog identity. */
  name: virtualBoxText(VIRTUALBOX_NAME_MAX_LENGTH),
  osType: virtualBoxText(VIRTUALBOX_OS_TYPE_MAX_LENGTH).nullable(),
  state: virtualBoxVmStateSchema.catch('unknown'),
  /** The `VMState` VirtualBox printed, kept so that an unknown state can still be shown. */
  rawState: z
    .string()
    .max(VIRTUALBOX_RAW_STATE_MAX_LENGTH)
    .regex(/^[\x21-\x7e]*$/)
    .nullable(),
  stateChangedAt: timestampSchema.nullable(),
  /** Unknown when the machine could not be inspected. */
  accessible: z.boolean().nullable(),
  memoryMb: z
    .number()
    .int()
    .min(0)
    .max(16 * 1024 * 1024)
    .nullable(),
  cpus: z.number().int().min(0).max(1024).nullable(),
  error: virtualBoxVmErrorSchema.catch('inspection_failed').nullable(),
});
export type VirtualBoxVm = z.infer<typeof virtualBoxVmSchema>;

export const virtualBoxDiscoverySchema = z
  .object({
    status: virtualBoxDiscoveryStatusSchema,
    version: z
      .string()
      .max(VIRTUALBOX_VERSION_MAX_LENGTH)
      .regex(/^[A-Za-z0-9._-]+$/)
      .nullable(),
    /** Some machines were not listed or not inspected, because a limit was reached. */
    truncated: z.boolean(),
    vms: z.array(virtualBoxVmSchema).max(VIRTUALBOX_MAX_VMS),
  })
  .superRefine((report, context) => {
    const uuids = report.vms.map((vm) => vm.uuid);
    if (new Set(uuids).size !== uuids.length) {
      context.addIssue({ code: 'custom', message: 'Repeated VirtualBox UUID' });
    }
  });
export type VirtualBoxDiscovery = z.infer<typeof virtualBoxDiscoverySchema>;

/** What a VirtualBox part that fails validation is read as. The rest of the report still counts. */
export const INVALID_VIRTUALBOX_DISCOVERY: VirtualBoxDiscovery = {
  status: 'invalid_report',
  version: null,
  truncated: false,
  vms: [],
};

export const discoveryRequestPayloadSchema = z.strictObject({ operationId: z.uuid() });
export type DiscoveryRequestPayload = z.infer<typeof discoveryRequestPayloadSchema>;

/**
 * A report from an agent. It says nothing about which agent sent it: the identity comes from the
 * authenticated connection. Unknown fields, including any claim of identity, are dropped.
 */
export const discoveryResultPayloadSchema = z
  .object({
    operationId: z.uuid(),
    hostPlatform: platformSchema,
    emulators: z.array(discoveryEmulatorReportSchema).max(2),
    vms: z.array(discoveredVmSchema).max(DISCOVERY_MAX_VMS),
    skipped: z.array(discoverySkippedSchema).max(DISCOVERY_MAX_SKIPPED),
    /**
     * Absent from an agent that predates VirtualBox. A part that fails validation is replaced rather
     * than refused, so that it can never cost the 86Box and QEMU results.
     */
    virtualbox: virtualBoxDiscoverySchema.optional().catch(() => INVALID_VIRTUALBOX_DISCOVERY),
  })
  .superRefine((report, context) => {
    const identities = report.vms.map((vm) => `${vm.emulatorType}/${vmNameKey(vm.vmName)}`);
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: 'custom', message: 'Repeated VM identity' });
    }
  });
export type DiscoveryResultPayload = z.infer<typeof discoveryResultPayloadSchema>;

export const DISCOVERY_ERROR_CODES = ['busy', 'scan_failed', 'invalid_request'] as const;
export const discoveryErrorPayloadSchema = z.object({
  operationId: z.uuid(),
  code: z.enum(DISCOVERY_ERROR_CODES),
  message: z.string().max(256),
});
export type DiscoveryErrorPayload = z.infer<typeof discoveryErrorPayloadSchema>;

// What an administrator sees.

export const DISCOVERY_OPERATION_STATUSES = ['running', 'completed', 'failed'] as const;
export const discoveryOperationStatusSchema = z.enum(DISCOVERY_OPERATION_STATUSES);
export type DiscoveryOperationStatus = z.infer<typeof discoveryOperationStatusSchema>;

export const DISCOVERY_FAILURE_CODES = [
  'timeout',
  'agent_disconnected',
  'agent_revoked',
  'agent_busy',
  'agent_error',
  'malformed_result',
  'result_too_large',
] as const;
export const discoveryFailureCodeSchema = z.enum(DISCOVERY_FAILURE_CODES);
export type DiscoveryFailureCode = z.infer<typeof discoveryFailureCodeSchema>;

export const discoveryListedVmSchema = z.object({
  emulatorType: filesystemEmulatorTypeSchema,
  vmName: z.string(),
  markers: z.array(z.string()),
  hostCompatible: z.boolean().nullable(),
  /** Whether the catalog already has this identity. Worked out when read, never stored. */
  registered: z.boolean(),
});
export type DiscoveryListedVm = z.infer<typeof discoveryListedVmSchema>;

export const discoveryOperationSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  status: discoveryOperationStatusSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  failure: z.object({ code: discoveryFailureCodeSchema, message: z.string() }).nullable(),
  hostPlatform: platformSchema.nullable(),
  emulators: z.array(discoveryEmulatorReportSchema),
  vms: z.array(discoveryListedVmSchema),
  skipped: z.array(discoverySkippedSchema),
  /**
   * When a completed report stops being accepted for a registration, or `null` when it was never
   * usable (still running, or failed). Worked out when read, from the server's own policy.
   */
  expiresAt: timestampSchema.nullable().default(null),
  /**
   * Whether the report came over the agent's current connection. A report from before a reconnection
   * says nothing reliable about the disk any more, and the server refuses to register from it.
   */
  fromCurrentConnection: z.boolean().default(true),
  /**
   * What VirtualBox reported, or `null` when the agent did not report on VirtualBox at all, as an
   * agent older than VirtualBox support does. These machines are observations: none is registered.
   */
  virtualbox: virtualBoxDiscoverySchema.nullable().default(null),
  /**
   * Which of these machines this agent has already registered, and as which catalog VM. Worked out when read,
   * by UUID, never by name (decision 0045).
   */
  virtualboxRegistrations: z
    .array(z.object({ machineUuid: virtualBoxUuidSchema, vmName: z.string() }))
    .default([]),
});
export type DiscoveryOperation = z.infer<typeof discoveryOperationSchema>;

export const discoveryStateResponseSchema = z.object({
  /** The agent's latest operation since the API started, or `null`. Results are not persisted. */
  operation: discoveryOperationSchema.nullable(),
});
export type DiscoveryStateResponse = z.infer<typeof discoveryStateResponseSchema>;
