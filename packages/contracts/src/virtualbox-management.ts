import { z } from 'zod';
import { virtualBoxUuidSchema, virtualBoxVmStateSchema } from './discovery.js';
import { timestampSchema } from './version.js';
import { virtualBoxSourceSchema } from './virtualbox.js';

/**
 * VB3 (decision 0046): source links, OVA import into VirtualBox, deletion from VirtualBox, and screenshots.
 *
 * The catalog identity of a VirtualBox VM is `(virtualbox, vm_name)`, and it owns the master, its snapshots and its
 * screenshots. The VirtualBox UUID only names the machine the VM is linked to now, which can change: an import
 * creates a new machine with a new UUID, and an administrator links, relinks or unlinks it explicitly.
 */

const safeSizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const errorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .max(64);
const machineNameSchema = z
  .string()
  .max(256)
  .regex(/^\P{Cc}*$/u);

/** Longest name an imported machine may be given. */
export const VIRTUALBOX_TARGET_NAME_MAX_LENGTH = 128;

/** Characters an imported machine's name may not hold: VirtualBox names a folder after it. */
const TARGET_NAME_FORBIDDEN = /[\\/:*?"<>|]/;

export type VirtualBoxTargetNameError =
  'empty' | 'too_long' | 'invalid_characters' | 'invalid_boundary';
export type VirtualBoxTargetNameCheck =
  { ok: true } | { ok: false; code: VirtualBoxTargetNameError };

/**
 * Whether a name can be given to an imported machine. VirtualBox accepts nearly anything, but it also names the
 * machine's folder after it, so this keeps to what is a valid, unambiguous folder name on Windows, and to what
 * cannot be read as an option on a command line.
 */
export function validateVirtualBoxTargetName(name: string): VirtualBoxTargetNameCheck {
  if (name.length === 0) return { ok: false, code: 'empty' };
  if ([...name].length > VIRTUALBOX_TARGET_NAME_MAX_LENGTH) return { ok: false, code: 'too_long' };
  if (TARGET_NAME_FORBIDDEN.test(name) || /\p{Cc}/u.test(name)) {
    return { ok: false, code: 'invalid_characters' };
  }
  if (name !== name.trim() || name.endsWith('.') || name.startsWith('-')) {
    return { ok: false, code: 'invalid_boundary' };
  }
  return { ok: true };
}

export const virtualBoxTargetNameSchema = z
  .string()
  .refine((name) => validateVirtualBoxTargetName(name).ok, {
    message: 'Not a valid name for a VirtualBox machine',
  });

/** What an imported machine is called by default: the catalog title, and the version it comes from. */
export function defaultVirtualBoxTargetName(title: string, versionLabel: string): string {
  const cleaned = `${title} (${versionLabel})`
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^-+/, '')
    .replace(/\.+$/, '');
  const bounded = [...cleaned].slice(0, VIRTUALBOX_TARGET_NAME_MAX_LENGTH).join('').trim();
  return validateVirtualBoxTargetName(bounded).ok ? bounded : 'Imported machine';
}

// The protocol.

/**
 * Imports one version's OVA into the agent's VirtualBox as a new machine. The agent downloads it from the
 * repository, checks its size and SHA-256 against these, runs a dry run, imports it under `targetName`, and finds the
 * new machine by comparing VirtualBox's machines before and after. It never overwrites, renames or removes anything.
 */
export const virtualBoxImportPayloadSchema = z.strictObject({
  operationId: z.uuid(),
  vmName: z.string().min(1).max(64),
  versionId: z.uuid(),
  repositoryId: z.uuid(),
  archiveKey: z.string().min(1).max(512),
  archiveSizeBytes: safeSizeSchema.positive(),
  archiveSha256: sha256Schema,
  targetName: virtualBoxTargetNameSchema,
});
export type VirtualBoxImportPayload = z.infer<typeof virtualBoxImportPayloadSchema>;

/**
 * `unregistervm <uuid> --delete`, for exactly this machine, and only if VirtualBox still calls it `machineName` and
 * it is powered off when the agent looks again. The server sends it after an administrator typed that name.
 */
export const virtualBoxDeletePayloadSchema = z.strictObject({
  operationId: z.uuid(),
  machineUuid: virtualBoxUuidSchema,
  machineName: machineNameSchema.min(1),
});
export type VirtualBoxDeletePayload = z.infer<typeof virtualBoxDeletePayloadSchema>;

/** Closes an import or a deletion on the agent: the server has recorded its result. */
export const virtualBoxOperationAckPayloadSchema = z.strictObject({ operationId: z.uuid() });
export type VirtualBoxOperationAckPayload = z.infer<typeof virtualBoxOperationAckPayloadSchema>;

/**
 * `controlvm <uuid> screenshotpng`, for a running session of a linked machine. The image goes through the usual
 * media pipeline, under the catalog VM. A capture is acknowledged and retried with `server.qemu_capture_ack` and
 * `server.qemu_capture_retry`, which name nothing but the operation.
 */
export const virtualBoxCapturePayloadSchema = z.strictObject({
  operationId: z.uuid(),
  sessionId: z.uuid(),
  vmName: z.string().min(1).max(64),
  machineUuid: virtualBoxUuidSchema,
});
export type VirtualBoxCapturePayload = z.infer<typeof virtualBoxCapturePayloadSchema>;

export const virtualBoxCaptureReportPayloadSchema = z.object({
  operationId: z.uuid(),
  sessionId: z.uuid(),
  vmName: z.string().min(1).max(64),
  machineUuid: virtualBoxUuidSchema,
  state: z.enum(['capturing', 'uploading', 'failed']),
  sha256: sha256Schema.nullable(),
  uncertain: z.boolean(),
  code: errorCodeSchema.nullable(),
  message: z.string().max(1024).nullable(),
});
export type VirtualBoxCaptureReportPayload = z.infer<typeof virtualBoxCaptureReportPayloadSchema>;

export const VIRTUALBOX_OPERATION_STAGES = [
  'checking',
  'downloading',
  'verifying',
  'dry_run',
  'importing',
  'discovering',
  'deleting',
] as const;
export const virtualBoxOperationStageSchema = z.enum(VIRTUALBOX_OPERATION_STAGES);
export type VirtualBoxOperationStage = z.infer<typeof virtualBoxOperationStageSchema>;

export const virtualBoxOperationProgressPayloadSchema = z.object({
  operationId: z.uuid(),
  stage: virtualBoxOperationStageSchema,
  doneBytes: safeSizeSchema.nullable(),
  totalBytes: safeSizeSchema.nullable(),
});
export type VirtualBoxOperationProgressPayload = z.infer<
  typeof virtualBoxOperationProgressPayloadSchema
>;

/**
 * How an import or a deletion ended, as far as the agent can tell. `uncertain` is never success: an import that may
 * have created a machine EmuCat cannot name, or a deletion whose effect VirtualBox did not confirm.
 */
export const VIRTUALBOX_OPERATION_OUTCOMES = ['succeeded', 'failed', 'uncertain'] as const;
export const virtualBoxOperationOutcomeSchema = z.enum(VIRTUALBOX_OPERATION_OUTCOMES);
export type VirtualBoxOperationOutcome = z.infer<typeof virtualBoxOperationOutcomeSchema>;

/** A machine as the agent saw it after an operation. */
export const virtualBoxMachineSchema = z.object({
  uuid: virtualBoxUuidSchema,
  name: machineNameSchema,
  state: virtualBoxVmStateSchema.catch('unknown'),
});
export type VirtualBoxMachine = z.infer<typeof virtualBoxMachineSchema>;

export const virtualBoxOperationResultPayloadSchema = z.object({
  operationId: z.uuid(),
  kind: z.enum(['import', 'delete']),
  outcome: virtualBoxOperationOutcomeSchema,
  code: errorCodeSchema.nullable(),
  message: z.string().max(1024).nullable(),
  /** The imported machine, when exactly one new machine with the requested name was found. Never a guess. */
  machine: virtualBoxMachineSchema.nullable(),
  /**
   * Machines VirtualBox registered during an import that cannot be attributed to it with certainty, such as after a
   * failed or interrupted import. Reported so that an administrator can deal with them; nothing removes them.
   */
  strayMachines: z.array(virtualBoxMachineSchema).max(16).default([]),
  /** For a deletion: whether VirtualBox confirmed that it removed the machine's files. `null` when unknown. */
  filesRemoved: z.boolean().nullable(),
});
export type VirtualBoxOperationResultPayload = z.infer<
  typeof virtualBoxOperationResultPayloadSchema
>;

/** Where an agent's import or deletion journal is. Sent with `agent.registration_sync`. */
export const VIRTUALBOX_OPERATION_PHASES = ['running', 'irreversible', 'reported'] as const;
export const virtualBoxOperationSyncEntrySchema = z.object({
  operationId: z.uuid(),
  phase: z.enum(VIRTUALBOX_OPERATION_PHASES),
});
export type VirtualBoxOperationSyncEntry = z.infer<typeof virtualBoxOperationSyncEntrySchema>;

// What an administrator sees and does.

export const VIRTUALBOX_OPERATION_KINDS = ['import', 'delete', 'link', 'relink', 'unlink'] as const;
export const virtualBoxOperationKindSchema = z.enum(VIRTUALBOX_OPERATION_KINDS);
export type VirtualBoxOperationKind = z.infer<typeof virtualBoxOperationKindSchema>;

export const VIRTUALBOX_OPERATION_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'uncertain',
] as const;
export const virtualBoxOperationStateSchema = z.enum(VIRTUALBOX_OPERATION_STATES);
export type VirtualBoxOperationState = z.infer<typeof virtualBoxOperationStateSchema>;

export function isVirtualBoxOperationActive(state: VirtualBoxOperationState): boolean {
  return state === 'queued' || state === 'running';
}

/**
 * What an import does with its machine once VirtualBox has it: link it to a VM that had none, or replace the link
 * an administrator explicitly agreed to replace.
 */
export const VIRTUALBOX_AUTO_LINK_INTENTS = ['link', 'relink'] as const;
export const virtualBoxAutoLinkIntentSchema = z.enum(VIRTUALBOX_AUTO_LINK_INTENTS);
export type VirtualBoxAutoLinkIntent = z.infer<typeof virtualBoxAutoLinkIntentSchema>;

/**
 * `pending` until the import succeeded and the link was made or refused; `linked` once it was made; `failed` when
 * it was refused, which never undoes the import. `null` when the import itself did not succeed, so nothing was tried.
 */
export const VIRTUALBOX_AUTO_LINK_STATES = ['pending', 'linked', 'failed'] as const;
export const virtualBoxAutoLinkStateSchema = z.enum(VIRTUALBOX_AUTO_LINK_STATES);
export type VirtualBoxAutoLinkState = z.infer<typeof virtualBoxAutoLinkStateSchema>;

export const virtualBoxAutoLinkSchema = z.object({
  intent: virtualBoxAutoLinkIntentSchema,
  state: virtualBoxAutoLinkStateSchema.nullable(),
  /** The link or relink this made, once it is made. */
  linkOperationId: z.uuid().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type VirtualBoxAutoLink = z.infer<typeof virtualBoxAutoLinkSchema>;

/** One import, deletion or change of link, as recorded. A link change is recorded when it is made. */
export const virtualBoxOperationSchema = z.object({
  id: z.uuid(),
  kind: virtualBoxOperationKindSchema,
  state: virtualBoxOperationStateSchema,
  stage: virtualBoxOperationStageSchema.nullable(),
  agentId: z.uuid(),
  agentName: z.string(),
  vmName: z.string(),
  /** The version an import comes from. */
  versionId: z.uuid().nullable(),
  /** The name an import gives its new machine. */
  targetName: z.string().nullable(),
  /** The machine created, deleted or linked. */
  machineUuid: virtualBoxUuidSchema.nullable(),
  machineName: z.string().nullable(),
  machineState: virtualBoxVmStateSchema.nullable(),
  /**
   * For a relink or an unlink: the machine the VM was linked to before. For an import that replaces a link: the
   * machine it replaces, which must still be the linked one when the import finishes.
   */
  previousMachineUuid: virtualBoxUuidSchema.nullable(),
  /** For an import: what is done with its machine once it exists. `null` when nothing is. */
  autoLink: virtualBoxAutoLinkSchema.nullable().default(null),
  strayMachines: z.array(virtualBoxMachineSchema).default([]),
  filesRemoved: z.boolean().nullable(),
  progress: z.object({
    doneBytes: safeSizeSchema.nullable(),
    totalBytes: safeSizeSchema.nullable(),
  }),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  requestedByDisplayName: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
});
export type VirtualBoxOperation = z.infer<typeof virtualBoxOperationSchema>;

/** Links a machine to a catalog VM, or replaces the machine it is linked to. */
export const virtualBoxLinkRequestSchema = z
  .strictObject({
    agentId: z.uuid(),
    machineUuid: virtualBoxUuidSchema,
    /** The discovery that saw the machine, or the import that created it: one of the two. */
    discoveryOperationId: z.uuid().optional(),
    importOperationId: z.uuid().optional(),
    /**
     * The machine the administrator saw linked, or `null` for none. A relink names it, so that nothing replaces a
     * link that changed since the page was loaded.
     */
    replaceMachineUuid: virtualBoxUuidSchema.nullable(),
  })
  .refine(
    (request) =>
      (request.discoveryOperationId === undefined) !== (request.importOperationId === undefined),
    { message: 'Name the discovery that saw the machine, or the import that created it' },
  );
export type VirtualBoxLinkRequest = z.infer<typeof virtualBoxLinkRequestSchema>;

export const virtualBoxUnlinkRequestSchema = z.strictObject({ machineUuid: virtualBoxUuidSchema });
export type VirtualBoxUnlinkRequest = z.infer<typeof virtualBoxUnlinkRequestSchema>;

/**
 * An import links its new machine by itself when the VM has none. When the VM has one, the administrator either
 * keeps it (`replaceSource: false`) or explicitly replaces it (`true`), which needs that machine powered off, now
 * and again when the import finishes. `replaceMachineUuid` is the machine the administrator saw linked, or `null`
 * for none, so that an import never acts on a link that changed since the page was loaded.
 */
export const virtualBoxImportRequestSchema = z
  .strictObject({
    agentId: z.uuid(),
    targetName: virtualBoxTargetNameSchema,
    requestId: z.uuid(),
    replaceMachineUuid: virtualBoxUuidSchema.nullable(),
    replaceSource: z.boolean(),
  })
  .refine((request) => request.replaceMachineUuid !== null || !request.replaceSource, {
    message: 'Only a linked machine can be replaced',
  });
export type VirtualBoxImportRequest = z.infer<typeof virtualBoxImportRequestSchema>;

export const virtualBoxDeleteRequestSchema = z.strictObject({
  agentId: z.uuid(),
  machineUuid: virtualBoxUuidSchema,
  /** VirtualBox's name for the machine, typed again by the administrator. */
  confirmMachineName: z.string().min(1).max(256),
  requestId: z.uuid(),
});
export type VirtualBoxDeleteRequest = z.infer<typeof virtualBoxDeleteRequestSchema>;

/** An agent a VirtualBox VM could be linked to, imported on, or managed through. */
export const virtualBoxAgentOptionSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  online: z.boolean(),
  /** Whether it can link, watch and export machines (decision 0045). */
  virtualbox: z.boolean(),
  /** Whether it can also import, delete and capture (decision 0046). */
  management: z.boolean(),
});
export type VirtualBoxAgentOption = z.infer<typeof virtualBoxAgentOptionSchema>;

/** Everything the VM page shows about a VirtualBox VM's machine. */
export const virtualBoxManagementResponseSchema = z.object({
  source: virtualBoxSourceSchema.nullable(),
  /** The version the linked machine is known to come from, when that is known. */
  sourceVersionId: z.uuid().nullable(),
  agents: z.array(virtualBoxAgentOptionSchema),
  /** Newest first. */
  operations: z.array(virtualBoxOperationSchema),
});
export type VirtualBoxManagementResponse = z.infer<typeof virtualBoxManagementResponseSchema>;
