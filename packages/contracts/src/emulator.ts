import { z } from 'zod';

export const EMULATOR_TYPES = ['86box', 'qemu'] as const;

export const emulatorTypeSchema = z.enum(EMULATOR_TYPES);
export type EmulatorType = z.infer<typeof emulatorTypeSchema>;

export function isEmulatorType(value: unknown): value is EmulatorType {
  return emulatorTypeSchema.safeParse(value).success;
}

/**
 * Files that mark a directory as a VM root. A directory is a valid VM when its root contains at
 * least one of these as a regular file. Names are matched exactly so that the result does not
 * depend on whether the host filesystem is case-sensitive. See decision 0011.
 */
export const VM_ROOT_MARKERS: Readonly<Record<EmulatorType, readonly string[]>> = {
  '86box': ['86box.cfg'],
  qemu: ['run.bat', 'run.cmd', 'run-win.bat', 'run-win.cmd', 'run-mac.sh', 'run-linux.sh'],
};

export interface VmRootEntry {
  name: string;
  isFile: boolean;
}

export function isValidVmRoot(
  emulatorType: EmulatorType,
  rootEntries: readonly VmRootEntry[],
): boolean {
  const markers = VM_ROOT_MARKERS[emulatorType];
  return rootEntries.some((entry) => entry.isFile && markers.includes(entry.name));
}
