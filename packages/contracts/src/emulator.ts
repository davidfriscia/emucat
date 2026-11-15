import { z } from 'zod';

/**
 * Every catalog type. A `virtualbox` machine is registered and run through VBoxManage, by its UUID, and has no VM
 * directory. See decision 0045.
 */
export const EMULATOR_TYPES = ['86box', 'qemu', 'virtualbox'] as const;

export const emulatorTypeSchema = z.enum(EMULATOR_TYPES);
export type EmulatorType = z.infer<typeof emulatorTypeSchema>;

export function isEmulatorType(value: unknown): value is EmulatorType {
  return emulatorTypeSchema.safeParse(value).success;
}

/**
 * The types whose VMs are directories under a base path. Everything that reads a VM's files, or tells an agent to,
 * is typed by these, so that a VirtualBox machine can never be handed to it.
 */
export const FILESYSTEM_EMULATOR_TYPES = ['86box', 'qemu'] as const;
export const filesystemEmulatorTypeSchema = z.enum(FILESYSTEM_EMULATOR_TYPES);
export type FilesystemEmulatorType = z.infer<typeof filesystemEmulatorTypeSchema>;

export function isFilesystemEmulatorType(value: unknown): value is FilesystemEmulatorType {
  return filesystemEmulatorTypeSchema.safeParse(value).success;
}

/**
 * Files that mark a directory as a VM root. A directory is a valid VM when its root contains at
 * least one of these as a regular file. Names are matched exactly so that the result does not
 * depend on whether the host filesystem is case-sensitive. See decision 0011.
 */
export const VM_ROOT_MARKERS: Readonly<Record<FilesystemEmulatorType, readonly string[]>> = {
  '86box': ['86box.cfg'],
  qemu: ['run.bat', 'run.cmd', 'run-win.bat', 'run-win.cmd', 'run-mac.sh', 'run-linux.sh'],
};

export interface VmRootEntry {
  name: string;
  isFile: boolean;
}

export function isValidVmRoot(
  emulatorType: FilesystemEmulatorType,
  rootEntries: readonly VmRootEntry[],
): boolean {
  const markers = VM_ROOT_MARKERS[emulatorType];
  return rootEntries.some((entry) => entry.isFile && markers.includes(entry.name));
}
