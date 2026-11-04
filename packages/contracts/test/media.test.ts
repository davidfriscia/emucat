import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEDIA_VISIBILITY,
  isExcludedFromArchive,
  isSameMedia,
  isWatchedMediaPath,
  parseVmRelativePath,
  resolvePublicCardImage,
  selectMainMedia,
  vmMediaSchema,
  type EmulatorType,
  type MediaVisibility,
} from '../src/index.js';
import { fixture } from './helpers.js';

const paths = fixture<{
  unsafe: string[];
  cases: { emulator: EmulatorType; path: string; excluded: boolean; watched: boolean }[];
}>('archive-paths');

const identity = { emulatorType: 'qemu', vmName: 'Win98' } as const;
const item = (id: string, visibility: MediaVisibility, isMain: boolean) => ({
  ...identity,
  id,
  visibility,
  isMain,
});

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
  it('defaults to private', () => {
    expect(DEFAULT_MEDIA_VISIBILITY).toBe('private');
    const parsed = vmMediaSchema.parse({
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
    expect(parsed.visibility).toBe('private');
    expect(parsed.isMain).toBe(false);
  });
});

describe('public catalog card image', () => {
  it('shows a published main item', () => {
    expect(resolvePublicCardImage(identity, [item('a', 'published', true)])).toEqual({
      kind: 'media',
      mediaId: 'a',
    });
  });

  it('shows a placeholder when there is no media', () => {
    expect(resolvePublicCardImage(identity, [])).toEqual({ kind: 'placeholder' });
  });

  it('shows a placeholder when the main item is private', () => {
    expect(resolvePublicCardImage(identity, [item('a', 'private', true)])).toEqual({
      kind: 'placeholder',
    });
  });

  it('does not promote another published item when the main item is privatized', () => {
    const media = [item('a', 'private', true), item('b', 'published', false)];
    expect(resolvePublicCardImage(identity, media)).toEqual({ kind: 'placeholder' });
  });

  it('does not promote another published item when the main item is deleted', () => {
    expect(resolvePublicCardImage(identity, [item('b', 'published', false)])).toEqual({
      kind: 'placeholder',
    });
  });

  it("ignores another VM's main media", () => {
    const foreign = { ...item('x', 'published', true), vmName: 'Other' };
    expect(resolvePublicCardImage(identity, [foreign])).toEqual({ kind: 'placeholder' });
  });
});

describe('main media selection', () => {
  it('keeps at most one main item', () => {
    const selected = selectMainMedia(
      identity,
      [item('a', 'private', true), item('b', 'private', false)],
      'b',
    );
    expect(selected.filter((media) => media.isMain).map((media) => media.id)).toEqual(['b']);
  });

  it("refuses another VM's media", () => {
    const foreign = { ...item('x', 'published', false), vmName: 'Other' };
    expect(() => selectMainMedia(identity, [item('a', 'private', true), foreign], 'x')).toThrow(
      /same VM/,
    );
  });

  it('does not change visibility', () => {
    const [selected] = selectMainMedia(identity, [item('a', 'private', false)], 'a');
    expect(selected?.visibility).toBe('private');
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
