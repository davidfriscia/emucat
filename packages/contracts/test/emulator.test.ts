import { describe, expect, it } from 'vitest';
import {
  emulatorTypeSchema,
  isEmulatorType,
  isValidVmRoot,
  type VmRootEntry,
} from '../src/index.js';
import { fixture } from './helpers.js';

describe('emulator type', () => {
  it.each(['86box', 'qemu'])('accepts %s', (value) => {
    expect(isEmulatorType(value)).toBe(true);
    expect(emulatorTypeSchema.parse(value)).toBe(value);
  });

  it.each(['', '86Box', 'QEMU', 'vmware', ' qemu', 86, null, undefined, {}])(
    'rejects %j',
    (value) => {
      expect(isEmulatorType(value)).toBe(false);
    },
  );
});

describe('VM root validity', () => {
  const { cases } = fixture<{
    cases: { emulator: '86box' | 'qemu'; entries: VmRootEntry[]; valid: boolean }[];
  }>('vm-roots');

  it.each(cases)('$emulator $entries -> $valid', ({ emulator, entries, valid }) => {
    expect(isValidVmRoot(emulator, entries)).toBe(valid);
  });
});
