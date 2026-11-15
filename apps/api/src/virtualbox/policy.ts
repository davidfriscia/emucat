import { isFilesystemEmulatorType, type FilesystemEmulatorType } from '@emucat/contracts';
import { ApiError } from '../errors.js';

/**
 * The emulator type of a VM whose files an agent reads, or the refusal for a VirtualBox VM, which has none. Every
 * command that names a VM directory goes through this, so that a VirtualBox VM can never reach one (decision 0045).
 */
export function filesystemOnly(emulatorType: string, what = 'This'): FilesystemEmulatorType {
  if (isFilesystemEmulatorType(emulatorType)) return emulatorType;
  throw new ApiError(
    409,
    'not_supported_for_virtualbox',
    `${what} is not available for VirtualBox machines: EmuCat runs them in VirtualBox, in place, and keeps their masters as OVA exports.`,
  );
}
