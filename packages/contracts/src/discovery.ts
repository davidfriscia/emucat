import { z } from 'zod';
import { emulatorTypeSchema, VM_ROOT_MARKERS, type EmulatorType } from './emulator.js';
import { platformSchema, type Platform } from './platform.js';
import { timestampSchema } from './version.js';
import { VM_NAME_ERROR_CODES, vmNameKey, vmNameSchema } from './vm-name.js';

/** Limits on one report. With these, a report always fits in one protocol message. */
export const DISCOVERY_MAX_VMS = 256;
export const DISCOVERY_MAX_SKIPPED = 64;
export const DISCOVERY_SKIPPED_NAME_MAX_LENGTH = 80;

/** The launch script each host can run. Scripts are reported, and never executed by discovery. */
export const QEMU_HOST_LAUNCH_SCRIPTS: Readonly<Record<Platform, string>> = {
  windows: 'run-win.cmd',
  macos: 'run-mac.sh',
  linux: 'run-linux.sh',
};

/**
 * Whether a VM has a launch script for this host. Only QEMU has a notion of this, so 86Box is `null`.
 * The agent implements the same rule, and both are tested against `fixtures/discovery-rules.json`.
 */
export function hostCompatibility(
  emulatorType: EmulatorType,
  markers: readonly string[],
  host: Platform,
): boolean | null {
  return emulatorType === 'qemu' ? markers.includes(QEMU_HOST_LAUNCH_SCRIPTS[host]) : null;
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
    emulatorType: emulatorTypeSchema,
    vmName: vmNameSchema,
    /** The markers present, as regular files, in the VM's root. */
    markers: z.array(z.string().max(32)).min(1).max(3),
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
  emulatorType: emulatorTypeSchema,
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
  emulatorType: emulatorTypeSchema,
  status: discoveryEmulatorStatusSchema,
  /** Some entries were not examined or not reported, because a limit was reached. */
  truncated: z.boolean(),
});
export type DiscoveryEmulatorReport = z.infer<typeof discoveryEmulatorReportSchema>;

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
  emulatorType: emulatorTypeSchema,
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
});
export type DiscoveryOperation = z.infer<typeof discoveryOperationSchema>;

export const discoveryStateResponseSchema = z.object({
  /** The agent's latest operation since the API started, or `null`. Results are not persisted. */
  operation: discoveryOperationSchema.nullable(),
});
export type DiscoveryStateResponse = z.infer<typeof discoveryStateResponseSchema>;
