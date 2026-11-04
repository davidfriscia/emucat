import { describe, expect, it } from 'vitest';
import {
  isValidVmName,
  sameVmIdentity,
  validateVmName,
  vmIdentitySchema,
  vmNameKey,
  vmNameSchema,
  type VmNameErrorCode,
} from '../src/index.js';
import { fixture } from './helpers.js';

const names = fixture<{
  valid: string[];
  invalid: { name: string; code: VmNameErrorCode }[];
  sameIdentity: [string, string][];
}>('vm-names');

describe('VM name validation', () => {
  it.each(names.valid)('accepts %j', (name) => {
    expect(validateVmName(name)).toEqual({ ok: true });
    expect(vmNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(names.invalid)('rejects $name as $code', ({ name, code }) => {
    expect(validateVmName(name)).toEqual({ ok: false, code });
    expect(isValidVmName(name)).toBe(false);
    expect(vmNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('VM identity', () => {
  it.each(names.sameIdentity)('treats %j and %j as the same VM', (a, b) => {
    expect(vmNameKey(a)).toBe(vmNameKey(b));
    expect(
      sameVmIdentity({ emulatorType: 'qemu', vmName: a }, { emulatorType: 'qemu', vmName: b }),
    ).toBe(true);
  });

  it('keeps the same name under different emulators separate', () => {
    expect(
      sameVmIdentity({ emulatorType: 'qemu', vmName: 'a' }, { emulatorType: '86box', vmName: 'a' }),
    ).toBe(false);
  });

  it('rejects an identity with an unknown emulator or an unsafe name', () => {
    expect(vmIdentitySchema.safeParse({ emulatorType: 'vbox', vmName: 'a' }).success).toBe(false);
    expect(vmIdentitySchema.safeParse({ emulatorType: 'qemu', vmName: '../a' }).success).toBe(
      false,
    );
  });
});
