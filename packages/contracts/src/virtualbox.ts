import { z } from 'zod';
import {
  virtualBoxUuidSchema,
  virtualBoxVmStateSchema,
  type VirtualBoxVmState,
} from './discovery.js';
import { timestampSchema } from './version.js';

/**
 * Running registered VirtualBox machines, and watching their state. The agent runs VBoxManage against the original
 * machine, by UUID; nothing is imported or cloned, and only Local execution exists. See decision 0045.
 */

/** How often the agent inspects a machine that is active, and one that is not. */
export const VIRTUALBOX_ACTIVE_POLL_SECONDS = 15;
export const VIRTUALBOX_INACTIVE_POLL_SECONDS = 60;
/** Most machines one watch or one state report names. */
export const VIRTUALBOX_WATCH_MAX = 128;

/** States in which VirtualBox has a process for the machine: an EmuCat session is active. */
export const VIRTUALBOX_ACTIVE_STATES: readonly VirtualBoxVmState[] = [
  'running',
  'paused',
  'starting',
  'stopping',
  'stuck',
];

/** States in which the machine is not running at all: a session, if any, has ended. */
export const VIRTUALBOX_ENDED_STATES: readonly VirtualBoxVmState[] = [
  'powered_off',
  'saved',
  'aborted',
];

export function isVirtualBoxActive(state: VirtualBoxVmState): boolean {
  return VIRTUALBOX_ACTIVE_STATES.includes(state);
}

// The protocol.

/** Every machine registered for this agent. Replaces the previous list. */
export const virtualBoxWatchPayloadSchema = z.strictObject({
  machines: z.array(virtualBoxUuidSchema).max(VIRTUALBOX_WATCH_MAX),
});
export type VirtualBoxWatchPayload = z.infer<typeof virtualBoxWatchPayloadSchema>;

export const VIRTUALBOX_CONTROL_ACTIONS = ['start', 'acpi_shutdown', 'poweroff'] as const;
export const virtualBoxControlActionSchema = z.enum(VIRTUALBOX_CONTROL_ACTIONS);
export type VirtualBoxControlAction = z.infer<typeof virtualBoxControlActionSchema>;

/**
 * `startvm <uuid> --type gui`, `controlvm <uuid> acpipowerbutton` or `controlvm <uuid> poweroff`. The server sends a
 * power-off only after an administrator confirmed it. Success means VirtualBox accepted the command, never that the
 * machine has changed state: only an observation says that.
 */
export const virtualBoxControlPayloadSchema = z.strictObject({
  sessionId: z.uuid(),
  machineUuid: virtualBoxUuidSchema,
  action: virtualBoxControlActionSchema,
});
export type VirtualBoxControlPayload = z.infer<typeof virtualBoxControlPayloadSchema>;

const errorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .max(64);

export const virtualBoxControlResultPayloadSchema = z.object({
  sessionId: z.uuid(),
  machineUuid: virtualBoxUuidSchema,
  action: virtualBoxControlActionSchema,
  accepted: z.boolean(),
  code: errorCodeSchema.nullable(),
  message: z.string().max(1024).nullable(),
});
export type VirtualBoxControlResultPayload = z.infer<typeof virtualBoxControlResultPayloadSchema>;

/** One machine, as the agent last saw it. A machine VBoxManage no longer lists is `present: false`. */
export const virtualBoxObservationSchema = z.object({
  machineUuid: virtualBoxUuidSchema,
  present: z.boolean(),
  name: z
    .string()
    .max(256)
    .regex(/^\P{Cc}*$/u)
    .nullable(),
  state: virtualBoxVmStateSchema.catch('unknown'),
  rawState: z
    .string()
    .max(32)
    .regex(/^[\x21-\x7e]*$/)
    .nullable(),
  stateChangedAt: timestampSchema.nullable(),
  accessible: z.boolean().nullable(),
  observedAt: timestampSchema,
});
export type VirtualBoxObservation = z.infer<typeof virtualBoxObservationSchema>;

/**
 * What the agent has seen. `complete` is the answer to a watch, with every watched machine; otherwise only machines
 * whose observation changed are listed. A machine the agent could not inspect is not listed at all: its previous
 * observation still stands.
 */
export const virtualBoxStatesPayloadSchema = z.object({
  complete: z.boolean(),
  /** Whether VBoxManage could be run at all. When it cannot, nothing is known, and nothing is listed. */
  available: z.boolean(),
  machines: z.array(virtualBoxObservationSchema).max(VIRTUALBOX_WATCH_MAX),
});
export type VirtualBoxStatesPayload = z.infer<typeof virtualBoxStatesPayloadSchema>;

// What an administrator sees.

/** Where a registered VirtualBox VM really is, and what it was last seen doing. */
export const virtualBoxSourceSchema = z.object({
  machineUuid: virtualBoxUuidSchema,
  agentId: z.uuid(),
  agentName: z.string(),
  agentOnline: z.boolean(),
  /** VirtualBox's own name for the machine, as last seen. Display text only. */
  displayName: z.string(),
  state: virtualBoxVmStateSchema.nullable(),
  rawState: z.string().nullable(),
  /** `false` once VBoxManage no longer lists the machine. The catalog entry and its master stay. */
  present: z.boolean().nullable(),
  accessible: z.boolean().nullable(),
  observedAt: timestampSchema.nullable(),
});
export type VirtualBoxSource = z.infer<typeof virtualBoxSourceSchema>;
