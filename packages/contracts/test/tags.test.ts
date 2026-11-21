import { describe, expect, it } from 'vitest';
import {
  createTagRequestSchema,
  formatTag,
  normalizeTagInput,
  setEntityTagsRequestSchema,
  tagSearchTerm,
  TAG_NAME_MAX_LENGTH,
  TAGS_PER_ENTITY_MAX,
} from '../src/index.js';

describe('tag names', () => {
  it.each([
    ['retro', 'retro', 'retro'],
    ['  Retro  ', 'Retro', 'retro'],
    ['#retro', 'retro', 'retro'],
    ['## Retro', 'Retro', 'retro'],
    ['Windows 95', 'Windows-95', 'windows-95'],
    ['windows\t  98', 'windows-98', 'windows-98'],
    ['ＤＯＳ', 'DOS', 'dos'],
    ['c++', 'c++', 'c++'],
    ['Ångström_2.0', 'Ångström_2.0', 'ångström_2.0'],
  ])('normalizes %j', (raw, name, normalizedName) => {
    expect(normalizeTagInput(raw)).toEqual({ ok: true, name, normalizedName });
  });

  it.each([
    '',
    '   ',
    '#',
    '# ',
    '-dos',
    '.hidden',
    'a#b',
    'semi;colon',
    '<b>',
    'a/b',
    'x'.repeat(TAG_NAME_MAX_LENGTH + 1),
  ])('refuses %j', (raw) => {
    expect(normalizeTagInput(raw).ok).toBe(false);
    expect(createTagRequestSchema.safeParse({ name: raw }).success).toBe(false);
  });

  it('accepts the longest name', () => {
    expect(normalizeTagInput('x'.repeat(TAG_NAME_MAX_LENGTH)).ok).toBe(true);
  });

  it('is shown with a #, which is not part of it', () => {
    expect(formatTag('retro')).toBe('#retro');
  });
});

describe('tag search terms', () => {
  it('treats a leading # as a request for that tag alone', () => {
    expect(tagSearchTerm('#Windows 95')).toEqual({ tagOnly: true, term: 'windows-95' });
    expect(tagSearchTerm('windows')).toEqual({ tagOnly: false, term: 'windows' });
    expect(tagSearchTerm('#')).toBeNull();
    expect(tagSearchTerm('   ')).toBeNull();
  });
});

describe('assigning tags', () => {
  const id = (n: number) => `018f47a0-7c2b-4f7e-9a3d-${n.toString().padStart(12, '0')}`;
  it('refuses a tag listed twice, and more than the limit', () => {
    expect(setEntityTagsRequestSchema.safeParse({ tagIds: [id(1), id(2)] }).success).toBe(true);
    expect(setEntityTagsRequestSchema.safeParse({ tagIds: [id(1), id(1)] }).success).toBe(false);
    const many = Array.from({ length: TAGS_PER_ENTITY_MAX + 1 }, (_, n) => id(n));
    expect(setEntityTagsRequestSchema.safeParse({ tagIds: many }).success).toBe(false);
    expect(setEntityTagsRequestSchema.safeParse({ tagIds: [] }).success).toBe(true);
  });
});
