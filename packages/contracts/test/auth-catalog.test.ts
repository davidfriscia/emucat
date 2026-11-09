import { describe, expect, it } from 'vitest';
import {
  adminCatalogQuerySchema,
  adminMediaPath,
  adminMediaSchema,
  PUBLIC_COVER_STATUSES,
  isValidUsername,
  loginRequestSchema,
  newPasswordSchema,
  publicCatalogQuerySchema,
  publicMediaSchema,
  publicVmRoute,
  setupRequestSchema,
  updateVmMetadataRequestSchema,
  vmDescriptionSchema,
  vmDisplayNameSchema,
  vmPathParamsSchema,
  vmTitle,
} from '../src/index.js';

describe('usernames', () => {
  it.each(['admin', 'a.b-c_d', 'A1B', 'x'.repeat(64)])('accepts %s', (name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it.each(['', 'ab', '.admin', 'admin.', 'a b c', 'admín', "a'--", 'x'.repeat(65), 'аdmin'])(
    'rejects %j',
    (name) => {
      expect(isValidUsername(name)).toBe(false);
    },
  );
});

describe('passwords', () => {
  it('enforces the length limits and keeps whitespace', () => {
    expect(newPasswordSchema.safeParse('short').success).toBe(false);
    expect(newPasswordSchema.safeParse('x'.repeat(257)).success).toBe(false);
    expect(newPasswordSchema.parse('  twelve chars  ')).toBe('  twelve chars  ');
  });

  it('does not echo the password in validation messages', () => {
    const result = newPasswordSchema.safeParse('hunter2');
    expect(JSON.stringify(result.error?.issues)).not.toContain('hunter2');
  });
});

describe('authentication requests', () => {
  it('rejects unknown fields, such as an attempt to pick a role', () => {
    const base = {
      setupToken: 'token',
      username: 'admin',
      displayName: 'Admin',
      password: 'correct horse battery',
    };
    expect(setupRequestSchema.safeParse(base).success).toBe(true);
    expect(setupRequestSchema.safeParse({ ...base, role: 'admin' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ username: 'a', password: 'b', admin: 1 }).success).toBe(
      false,
    );
  });

  it('requires string credentials', () => {
    expect(loginRequestSchema.safeParse({ username: { $ne: 1 }, password: 'x' }).success).toBe(
      false,
    );
  });
});

describe('VM metadata', () => {
  it('cannot express a change of identity', () => {
    for (const field of ['vmName', 'emulatorType', 'visibility', 'registered_by_user_id']) {
      expect(
        updateVmMetadataRequestSchema.safeParse({ displayName: 'x', [field]: 'y' }).success,
      ).toBe(false);
    }
  });

  it('requires at least one change', () => {
    expect(updateVmMetadataRequestSchema.safeParse({}).success).toBe(false);
  });

  it('allows clearing a field with null', () => {
    expect(updateVmMetadataRequestSchema.parse({ displayName: null })).toEqual({
      displayName: null,
    });
  });

  it('validates display names', () => {
    expect(vmDisplayNameSchema.parse('  Windows 98  ')).toBe('Windows 98');
    expect(vmDisplayNameSchema.parse('Café 日本語 🐈')).toBe('Café 日本語 🐈');
    expect(vmDisplayNameSchema.safeParse('   ').success).toBe(false);
    expect(vmDisplayNameSchema.safeParse('a\u0000b').success).toBe(false);
    expect(vmDisplayNameSchema.safeParse('a\nb').success).toBe(false);
    expect(vmDisplayNameSchema.safeParse('x'.repeat(256)).success).toBe(false);
  });

  it('validates descriptions', () => {
    expect(vmDescriptionSchema.parse('Line 1\n\tLine 2\r\n')).toBe('Line 1\n\tLine 2\r\n');
    expect(vmDescriptionSchema.safeParse('a\u0000b').success).toBe(false);
    expect(vmDescriptionSchema.safeParse('a\u001bb').success).toBe(false);
    expect(vmDescriptionSchema.safeParse('x'.repeat(10_001)).success).toBe(false);
  });

  it('uses the display name as the title, falling back to the VM name', () => {
    expect(vmTitle({ displayName: 'Windows 98', vmName: 'win98' })).toBe('Windows 98');
    expect(vmTitle({ displayName: null, vmName: 'win98' })).toBe('win98');
  });
});

describe('catalog queries', () => {
  it('applies defaults', () => {
    expect(publicCatalogQuerySchema.parse({})).toEqual({ page: 1, pageSize: 24 });
  });

  it.each([
    { page: '0' },
    { page: '-1' },
    { page: '1.5' },
    { page: 'abc' },
    { page: '' },
    { pageSize: '101' },
    { emulatorType: 'dosbox' },
    { q: 'x'.repeat(101) },
    { q: ['a', 'b'] },
    { unknown: '1' },
  ])('rejects %j', (query) => {
    expect(publicCatalogQuerySchema.safeParse(query).success).toBe(false);
  });

  it('does not offer the visibility filter publicly', () => {
    expect(publicCatalogQuerySchema.safeParse({ visibility: 'private' }).success).toBe(false);
    expect(adminCatalogQuerySchema.safeParse({ visibility: 'private' }).success).toBe(true);
  });
});

describe('paths', () => {
  it('validates identity in path parameters', () => {
    expect(
      vmPathParamsSchema.safeParse({ emulatorType: 'qemu', vmName: '../../etc' }).success,
    ).toBe(false);
    expect(vmPathParamsSchema.safeParse({ emulatorType: 'x', vmName: 'win98' }).success).toBe(
      false,
    );
  });

  it('encodes VM names', () => {
    const vm = { emulatorType: 'qemu', vmName: 'Windows 98 SE' } as const;
    expect(publicVmRoute(vm)).toBe('/vms/qemu/Windows%2098%20SE');
    expect(adminMediaPath(vm, 'id', 'full')).toBe(
      '/api/v1/admin/vms/qemu/Windows%2098%20SE/media/id/full',
    );
  });
});

describe('public media shape', () => {
  it('refuses any field beyond the public ones', () => {
    const id = '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60';
    expect(publicMediaSchema.safeParse({ id, widthPx: 1, heightPx: 1 }).success).toBe(true);
    expect(
      publicMediaSchema.safeParse({ id, widthPx: 1, heightPx: 1, jpegKey: 'a.jpg' }).success,
    ).toBe(false);
  });
});

describe('publication is decided by the VM alone', () => {
  const media = {
    id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60',
    isMain: true,
    originalFilename: 'a.png',
    originalSizeBytes: 1,
    widthPx: 1,
    heightPx: 1,
    capturedAt: null,
    createdAt: '2026-01-31T15:30:00Z',
    shownAsPublicMain: true,
  };

  it('gives an administrator no per-media visibility to read', () => {
    expect(adminMediaSchema.safeParse(media).success).toBe(true);
    expect(adminMediaSchema.safeParse({ ...media, visibility: 'published' }).success).toBe(false);
  });

  it('has no cover status for a private main image', () => {
    expect(PUBLIC_COVER_STATUSES).toEqual(['shown', 'vm_private', 'no_main_image']);
  });
});
