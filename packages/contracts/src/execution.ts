import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';
import { sha256HexSchema, timestampSchema } from './version.js';
import { vmNameSchema } from './vm-name.js';

/**
 * Running a VM. Only the agent starts or stops an emulator, from a command line it builds and checks
 * itself; the server and the browser only ever name a VM, an agent and a mode. See decisions 0028 to 0033.
 */

/**
 * Where a session runs, and what happens to its changes. `local` runs the agent's persistent copy.
 * `remote_snapshot` runs a working copy of a chosen version, whose changes become a snapshot only when an
 * administrator asks (decision 0038). `remote_volatile` is not implemented. A mode that cannot run is
 * refused, never quietly replaced by another.
 */
export const EXECUTION_MODES = ['local', 'remote_volatile', 'remote_snapshot'] as const;
export const executionModeSchema = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

/** The modes this version implements. A newer agent may say more in its capabilities. */
export const IMPLEMENTED_EXECUTION_MODES: readonly ExecutionMode[] = ['local', 'remote_snapshot'];

export const EXECUTION_MODE_UNAVAILABLE_REASONS: Record<Exclude<ExecutionMode, 'local'>, string> = {
  remote_volatile:
    'Remote volatile sessions need a remote display and a disposable working copy, which this version does not provide.',
  remote_snapshot:
    'Remote Snapshot runs a working copy of a version. Start it from the version history, which prepares the working copy first.',
};

const safeSizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const errorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .max(64);
const errorMessageSchema = z.string().max(1024);

// The protocol.

/** A launch names a VM and a mode. The agent finds the emulator, the directory and the arguments. */
export const vmLaunchPayloadSchema = z.strictObject({
  sessionId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  mode: executionModeSchema,
  /** The version the local copy is believed to come from, for the record only. */
  versionId: z.uuid().nullable(),
  /** For `remote_snapshot` only: the working copy to run. The agent finds its directory itself. */
  workspaceId: z.uuid().optional(),
});
export type VmLaunchPayload = z.infer<typeof vmLaunchPayloadSchema>;

/** `force` ends the process at once. The server only sends it after an explicit confirmation. */
export const vmStopPayloadSchema = z.strictObject({
  sessionId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  force: z.boolean(),
});
export type VmStopPayload = z.infer<typeof vmStopPayloadSchema>;

/** The server has recorded a session's end, or an administrator dismissed an unknown one. */
export const vmExecutionAckPayloadSchema = z.strictObject({ sessionId: z.uuid() });
export type VmExecutionAckPayload = z.infer<typeof vmExecutionAckPayloadSchema>;

export const AGENT_EXECUTION_STATES = [
  'starting',
  'running',
  'stopping',
  'stopped',
  'exited',
  'failed',
  'unknown',
] as const;
export const agentExecutionStateSchema = z.enum(AGENT_EXECUTION_STATES);
export type AgentExecutionState = z.infer<typeof agentExecutionStateSchema>;

export const vmExecutionStatusPayloadSchema = z.object({
  sessionId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  state: agentExecutionStateSchema,
  pid: z.number().int().nonnegative().max(0xffff_ffff).nullable(),
  /** When the operating system says the process was created. With the PID, it names the process. */
  processStartedAt: timestampSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  exitCode: z.number().int().nullable(),
  stopRequested: z.boolean(),
  /** Whether this run of the agent can ask the emulator to stop, rather than only end it. */
  gracefulStopAvailable: z.boolean(),
  code: errorCodeSchema.nullable(),
  message: errorMessageSchema.nullable(),
});
export type VmExecutionStatusPayload = z.infer<typeof vmExecutionStatusPayloadSchema>;

export const EXECUTION_SYNC_SESSIONS_MAX = 64;

/** Sent after each welcome: every session the agent has a journal for, and what it can launch. */
export const executionSyncPayloadSchema = z.object({
  sessions: z.array(vmExecutionStatusPayloadSchema).max(EXECUTION_SYNC_SESSIONS_MAX),
  capabilities: z.object({
    emulators: z
      .array(
        z.object({
          emulatorType: emulatorTypeSchema,
          launchable: z.boolean(),
          problem: errorMessageSchema.nullable(),
        }),
      )
      .max(2),
    modes: z.array(executionModeSchema).max(3),
  }),
  /** Verifications the agent has not closed yet. */
  verifications: z.array(z.uuid()).max(256),
});
export type ExecutionSyncPayload = z.infer<typeof executionSyncPayloadSchema>;

/** Names a master and a local VM. The agent checks the manifest's SHA-256, whichever copy it reads. */
export const vmVerifyPayloadSchema = z.strictObject({
  operationId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  versionId: z.uuid(),
  repositoryId: z.uuid(),
  archiveKey: z.string().min(1).max(512),
  archiveSizeBytes: safeSizeSchema.positive(),
  archiveSha256: sha256HexSchema,
  manifestSha256: sha256HexSchema.nullable(),
});
export type VmVerifyPayload = z.infer<typeof vmVerifyPayloadSchema>;

export const vmVerifyAckPayloadSchema = z.strictObject({ operationId: z.uuid() });
export type VmVerifyAckPayload = z.infer<typeof vmVerifyAckPayloadSchema>;

export const VERIFY_RESULT_STATUSES = [
  'verified',
  'modified',
  'missing',
  'unavailable',
  'verification_failed',
] as const;
export const verifyResultStatusSchema = z.enum(VERIFY_RESULT_STATUSES);
export type VerifyResultStatus = z.infer<typeof verifyResultStatusSchema>;

export const VERIFY_LISTED_PATHS_MAX = 20;
/** A complete count, and the first few paths. */
export const verifyPathListSchema = z.object({
  count: safeSizeSchema,
  paths: z.array(z.string().max(256)).max(VERIFY_LISTED_PATHS_MAX),
});
export type VerifyPathList = z.infer<typeof verifyPathListSchema>;

export const VERIFY_MANIFEST_SOURCES = ['local', 'cache', 'repository'] as const;

export const vmVerifyResultPayloadSchema = z.object({
  operationId: z.uuid(),
  /** The nil UUID when the agent could not read the request at all. */
  versionId: z.uuid(),
  status: verifyResultStatusSchema,
  filesVerified: safeSizeSchema,
  bytesHashed: safeSizeSchema,
  durationMs: safeSizeSchema,
  missing: verifyPathListSchema,
  modified: verifyPathListSchema,
  unexpected: verifyPathListSchema,
  manifestSha256: sha256HexSchema.nullable(),
  manifestSource: z.enum(VERIFY_MANIFEST_SOURCES).nullable(),
  code: errorCodeSchema.nullable(),
  message: errorMessageSchema.nullable(),
});
export type VmVerifyResultPayload = z.infer<typeof vmVerifyResultPayloadSchema>;

// What an administrator asks for, and sees.

/**
 * A session as the server records it. `requested` is the server's own state until the agent answers;
 * `interrupted` means the agent no longer knows the session, which deletes nothing.
 */
export const VM_SESSION_STATES = [
  'requested',
  'starting',
  'running',
  'stopping',
  'stopped',
  'exited',
  'failed',
  'interrupted',
  'unknown',
] as const;
export const vmSessionStateSchema = z.enum(VM_SESSION_STATES);
export type VmSessionState = z.infer<typeof vmSessionStateSchema>;

export const VM_SESSION_ACTIVE_STATES: readonly VmSessionState[] = [
  'requested',
  'starting',
  'running',
  'stopping',
  'unknown',
];

export function isSessionActive(state: VmSessionState): boolean {
  return VM_SESSION_ACTIVE_STATES.includes(state);
}

/** Whether the emulator may be running now, which is what protects the VM's files. */
export function isSessionBlocking(state: VmSessionState): boolean {
  return isSessionActive(state);
}

/** Every failure with a code. A newer agent's unknown codes are still shown, with their text. */
export const EXECUTION_ERROR_CODES = [
  // Launching.
  'launch_unsupported_platform',
  'emulator_not_configured',
  'executable_invalid',
  'vm_not_available',
  'vm_unsafe',
  'vm_configuration_missing',
  'launch_configuration_required',
  'launch_failed',
  'launch_exited_early',
  'execution_mode_unavailable',
  'vm_already_running',
  'vm_busy',
  'workspace_unavailable',
  'state_unwritable',
  // Stopping.
  'graceful_stop_unavailable',
  'stop_timeout',
  'stop_failed',
  'stop_unavailable',
  'forced',
  // Recovery.
  'agent_restarted',
  'exited_while_agent_away',
  'process_state_unknown',
  'agent_lost_session',
  'launch_not_acknowledged',
  'agent_revoked',
  'internal_error',
] as const;
export type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODES)[number];

const EXECUTION_RECOVERY: Partial<Record<string, string>> = {
  launch_unsupported_platform: 'Launching is only implemented in the Windows agent.',
  emulator_not_configured:
    'Configure this emulator’s base path and executable on the agent, and restart the agent.',
  executable_invalid:
    'Point the agent’s executable setting at the real 86Box.exe or qemu-system-*.exe, and restart the agent.',
  vm_not_available: 'The VM is not in the agent’s base path. Restore it first.',
  vm_unsafe: 'The VM directory is a link or reparse point, which the agent never launches.',
  vm_configuration_missing:
    'The VM has no configuration file the emulator can start from. Check the VM directory.',
  launch_configuration_required:
    'The VM’s launcher cannot be interpreted safely. Add an emucat-launch.json launch profile to the VM, as described in docs/launcher.md.',
  launch_failed: 'The operating system refused to start the emulator. Check the agent’s log.',
  launch_exited_early:
    'The emulator exited at once. Start it by hand on that computer to see why, for example a missing ROM.',
  execution_mode_unavailable:
    'This agent cannot run this mode. Remote Snapshot needs an up-to-date agent; Remote Volatile is not available in this version.',
  workspace_unavailable:
    'The working copy is not on the agent. Prepare a new one from the version history.',
  vm_already_running: 'The VM is already running on that agent.',
  vm_busy: 'A registration, restore or verification of this VM is in progress. Wait for it to end.',
  state_unwritable: 'Check the agent’s state directory, and try again.',
  graceful_stop_unavailable:
    'The emulator cannot be asked to stop gracefully now. Close it on that computer, or force a stop.',
  stop_timeout:
    'The emulator is still running. Shut the guest down from inside the VM, or force a stop.',
  stop_failed: 'The emulator could not be ended. Check the agent’s log.',
  stop_unavailable:
    'The agent has no verified handle on this emulator, so it will not stop anything. Close it on that computer.',
  forced: 'The emulator was ended at once. Its disks may need checking inside the guest.',
  agent_restarted:
    'The agent restarted while starting the emulator. Check that computer, then dismiss the session.',
  exited_while_agent_away:
    'The emulator ended while the agent was not running, so its exit code is not known.',
  process_state_unknown:
    'The agent cannot tell whether the emulator still runs. Check that computer, then dismiss the session.',
  agent_lost_session:
    'The agent no longer knows this session, for example because its state directory was removed. Check that computer.',
  launch_not_acknowledged:
    'The agent did not answer the launch. Nothing was started. Check that the agent is up to date and connected.',
  agent_revoked: 'Pair the agent again to use it.',
};

export function executionRecovery(code: string): string | null {
  return EXECUTION_RECOVERY[code] ?? null;
}

const VERIFY_RECOVERY: Partial<Record<string, string>> = {
  vm_running: 'Stop the VM, then verify again.',
  vm_not_found: 'The VM is not on that computer. Restore it to get a copy.',
  agent_busy: 'Wait for the agent’s other operation to finish.',
  agent_restarted: 'The agent restarted during the verification. Verify again.',
  verification_failed:
    'The files could not be compared reliably, for example because one changed during the check. Stop the VM and verify again.',
  invalid_request: 'Update the agent and the server to the same version.',
  agent_lost_operation: 'The agent no longer knows this verification. Verify again.',
  verify_not_acknowledged:
    'The agent did not answer. Check that it is up to date and connected, and verify again.',
};

export function verifyRecovery(code: string): string | null {
  return VERIFY_RECOVERY[code] ?? null;
}

export const launchRequestSchema = z
  .strictObject({
    agentId: z.uuid(),
    emulatorType: emulatorTypeSchema,
    vmName: vmNameSchema,
    mode: executionModeSchema,
    /** Chosen by the browser, so that a repeated click or a retried request starts one session. */
    requestId: z.uuid(),
    /** A ready Remote Snapshot working copy. Required for `remote_snapshot`, refused otherwise. */
    workspaceId: z.uuid().optional(),
  })
  .refine(
    (request) => (request.mode === 'remote_snapshot') === (request.workspaceId !== undefined),
    {
      message: 'A Remote Snapshot session runs a working copy, and only it names one',
      path: ['workspaceId'],
    },
  );
export type LaunchRequest = z.infer<typeof launchRequestSchema>;

/** A forced stop must repeat the VM's name, as typed by the administrator. */
export const stopSessionRequestSchema = z
  .strictObject({
    force: z.boolean(),
    confirmVmName: z.string().max(255).optional(),
  })
  .refine((request) => !request.force || (request.confirmVmName ?? '').length > 0, {
    message: 'A forced stop ends the emulator at once, and has to be confirmed',
    path: ['confirmVmName'],
  });
export type StopSessionRequest = z.infer<typeof stopSessionRequestSchema>;

/**
 * Says that a session the agent cannot account for is over, which lets destructive work on the VM go
 * ahead. It repeats the VM's name, as typed by the administrator.
 */
export const dismissSessionRequestSchema = z.strictObject({
  confirmVmName: z.string().min(1).max(255),
});
export type DismissSessionRequest = z.infer<typeof dismissSessionRequestSchema>;

export const vmSessionPathParamsSchema = z.strictObject({ sessionId: z.uuid() });

export const vmSessionSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  agentName: z.string(),
  agentOnline: z.boolean(),
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  mode: executionModeSchema,
  state: vmSessionStateSchema,
  versionId: z.uuid().nullable(),
  /** The working copy a `remote_snapshot` session runs. */
  workspaceId: z.uuid().nullable(),
  pid: z.number().int().nullable(),
  processStartedAt: timestampSchema.nullable(),
  requestedAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  exitCode: z.number().int().nullable(),
  stopRequested: z.boolean(),
  forceRequested: z.boolean(),
  gracefulStopAvailable: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  recovery: z.string().nullable(),
  requestedByDisplayName: z.string().nullable(),
  updatedAt: timestampSchema,
});
export type VmSession = z.infer<typeof vmSessionSchema>;

export const vmSessionListQuerySchema = z.strictObject({
  agentId: z.uuid().optional(),
  emulatorType: emulatorTypeSchema.optional(),
  vmName: vmNameSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const vmSessionListResponseSchema = z.object({ sessions: z.array(vmSessionSchema) });
export type VmSessionListResponse = z.infer<typeof vmSessionListResponseSchema>;

export const VERIFICATION_STATES = ['requested', 'completed', 'expired'] as const;

export const vmVerificationSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  agentName: z.string(),
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  versionId: z.uuid(),
  state: z.enum(VERIFICATION_STATES),
  status: verifyResultStatusSchema.nullable(),
  filesVerified: safeSizeSchema.nullable(),
  bytesHashed: safeSizeSchema.nullable(),
  durationMs: safeSizeSchema.nullable(),
  missing: verifyPathListSchema.nullable(),
  modified: verifyPathListSchema.nullable(),
  unexpected: verifyPathListSchema.nullable(),
  manifestSha256: sha256HexSchema.nullable(),
  manifestSource: z.enum(VERIFY_MANIFEST_SOURCES).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  recovery: z.string().nullable(),
  requestedByDisplayName: z.string().nullable(),
  requestedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});
export type VmVerification = z.infer<typeof vmVerificationSchema>;

export const verifyRequestSchema = z.strictObject({
  agentId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
});
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

export const verificationPathParamsSchema = z.strictObject({ verificationId: z.uuid() });

export const LAUNCH_INELIGIBLE_REASONS = [
  'agent_revoked',
  'agent_offline',
  'agent_cannot_launch',
  'emulator_not_launchable',
  'vm_not_on_agent',
  'session_active',
  'operation_in_progress',
] as const;
export type LaunchIneligibleReason = (typeof LAUNCH_INELIGIBLE_REASONS)[number];

export const VERIFY_INELIGIBLE_REASONS = [
  'agent_revoked',
  'agent_offline',
  'agent_cannot_verify',
  'no_master',
  'vm_not_on_agent',
  'session_active',
  'operation_in_progress',
] as const;
export type VerifyIneligibleReason = (typeof VERIFY_INELIGIBLE_REASONS)[number];

export const executionAgentOptionSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  online: z.boolean(),
  launch: z.object({
    eligible: z.boolean(),
    reason: z.enum(LAUNCH_INELIGIBLE_REASONS).nullable(),
    /** What the agent said about its executable, when it cannot launch. */
    problem: z.string().nullable(),
  }),
  verify: z.object({
    eligible: z.boolean(),
    reason: z.enum(VERIFY_INELIGIBLE_REASONS).nullable(),
  }),
  local: z.object({
    present: z.boolean(),
    contentStatus: z.enum(['unverified', 'verified', 'modified']).nullable(),
    sourceVersionId: z.uuid().nullable(),
    lastVerifiedAt: timestampSchema.nullable(),
  }),
  activeSession: vmSessionSchema.nullable(),
  lastSession: vmSessionSchema.nullable(),
  lastVerification: vmVerificationSchema.nullable(),
});
export type ExecutionAgentOption = z.infer<typeof executionAgentOptionSchema>;

export const executionOptionsResponseSchema = z.object({
  modes: z.array(
    z.object({
      mode: executionModeSchema,
      available: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  agents: z.array(executionAgentOptionSchema),
});
export type ExecutionOptionsResponse = z.infer<typeof executionOptionsResponseSchema>;
