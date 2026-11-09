import { describe, expect, it } from 'vitest';
import {
  isExcludedFromArchive,
  isSameMedia,
  isWatchedMediaPath,
  parseVmRelativePath,
  resolvePublicCardImage,
  selectMainMedia,
  vmMediaSchema,
  type EmulatorType,
} from '../src/index.js';
import { fixture } from './helpers.js';

const paths = fixture<{
  unsafe: string[];
  cases: { emulator: EmulatorType; path: string; excluded: boolean; watched: boolean }[];
}>('archive-paths');

const identity = { emulatorType: 'qemu', vmName: 'Win98' } as const;
const item = (id: string, isMain: boolean) => ({ ...identity, id, isMain });

describe('archive and media paths', () => {
  it.each(paths.cases)('$emulator $path', ({ emulator, path, excluded, watched }) => {
    expect(isExcludedFromArchive(emulator, path)).toBe(excluded);
    expect(isWatchedMediaPath(emulator, path)).toBe(watched);
  });

  it.each(paths.unsafe)('rejects unsafe path %j', (path) => {
    expect(parseVmRelativePath(path)).toBeNull();
    expect(() => isExcludedFromArchive('qemu', path)).toThrow(/Unsafe/);
    expect(isWatchedMediaPath('qemu', path)).toBe(false);
  });

  it('excludes every watched media file from archives', () => {
    for (const { emulator, path } of paths.cases.filter((entry) => entry.watched)) {
      expect(isExcludedFromArchive(emulator, path), path).toBe(true);
    }
  });
});

describe('media visibility', () => {
  const parsed = () =>
    vmMediaSchema.parse({
      ...identity,
      id: '018f47a0-7c2b-4f7e-9a3d-1b2c3d4e5f60',
      originalFilename: 'a.ppm',
      originalSha256: 'a'.repeat(64),
      originalSizeBytes: 1,
      jpegKey: 'j',
      thumbnailKey: 't',
      widthPx: 1,
      heightPx: 1,
      capturedAt: null,
      createdAt: '2026-01-31T15:30:00Z',
    });

  it('has no visibility of its own, and is not the main item by default', () => {
    expect(parsed()).not.toHaveProperty('visibility');
    expect(parsed().isMain).toBe(false);
  });

  it('drops a legacy per-media visibility value instead of trusting it', () => {
    for (const visibility of ['private', 'published']) {
      const legacy = vmMediaSchema.parse({ ...parsed(), visibility });
      expect(legacy).not.toHaveProperty('visibility');
    }
  });

  it('is no longer exported as a separate setting', async () => {
    const contracts: Record<string, unknown> = await import('../src/index.js');
    for (const name of [
      'MEDIA_VISIBILITIES',
      'mediaVisibilitySchema',
      'DEFAULT_MEDIA_VISIBILITY',
      'updateMediaVisibilityRequestSchema',
    ]) {
      expect(contracts, name).not.toHaveProperty(name);
    }
  });
});

describe('public catalog card image', () => {
  const publicVm = { ...identity, visibility: 'public' } as const;
  const privateVm = { ...identity, visibility: 'private' } as const;

  it("shows a public VM's main item", () => {
    expect(resolvePublicCardImage(publicVm, [item('a', true), item('b', false)])).toEqual({
      kind: 'media',
      mediaId: 'a',
    });
  });

  it("never shows a private VM's main item", () => {
    expect(resolvePublicCardImage(privateVm, [item('a', true)])).toEqual({ kind: 'placeholder' });
  });

  it('shows a placeholder when there is no media', () => {
    expect(resolvePublicCardImage(publicVm, [])).toEqual({ kind: 'placeholder' });
  });

  it('does not promote another item when the main item is cleared or deleted', () => {
    expect(resolvePublicCardImage(publicVm, [item('b', false), item('c', false)])).toEqual({
      kind: 'placeholder',
    });
  });

  it("ignores another VM's main media", () => {
    const foreign = { ...item('x', true), vmName: 'Other' };
    expect(resolvePublicCardImage(publicVm, [foreign])).toEqual({ kind: 'placeholder' });
  });
});

describe('main media selection', () => {
  it('keeps at most one main item', () => {
    const selected = selectMainMedia(identity, [item('a', true), item('b', false)], 'b');
    expect(selected.filter((media) => media.isMain).map((media) => media.id)).toEqual(['b']);
  });

  it("refuses another VM's media", () => {
    const foreign = { ...item('x', false), vmName: 'Other' };
    expect(() => selectMainMedia(identity, [item('a', true), foreign], 'x')).toThrow(/same VM/);
  });

  it('changes nothing but the main flag', () => {
    const [selected] = selectMainMedia(identity, [item('a', false)], 'a');
    expect(selected).toEqual({ ...item('a', true) });
  });
});

describe('media deduplication', () => {
  const upload = { ...identity, originalSha256: 'a'.repeat(64) };

  it('treats the same hash on the same VM as the same item, ignoring name case', () => {
    expect(isSameMedia(upload, { ...upload, vmName: 'WIN98' })).toBe(true);
  });

  it('keeps the same hash on different VMs separate', () => {
    expect(isSameMedia(upload, { ...upload, vmName: 'Other' })).toBe(false);
    expect(isSameMedia(upload, { ...upload, emulatorType: '86box' })).toBe(false);
  });

  it('keeps different hashes separate', () => {
    expect(isSameMedia(upload, { ...upload, originalSha256: 'b'.repeat(64) })).toBe(false);
  });
});
