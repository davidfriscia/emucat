import { describe, expect, it } from 'vitest';
import {
  CP437_HIGH,
  CP850_HIGH,
  archiveEntryQuerySchema,
  archivePreviewQuerySchema,
  decodeText,
  detectContent,
  detectEncoding,
  languageFor,
  looksLikeText,
  sniffPreviewImage,
} from '../src/index.js';

const bytes = (...values: Array<number | string>) =>
  Uint8Array.from(
    values.flatMap((value) =>
      typeof value === 'string' ? [...Buffer.from(value, 'latin1')] : [value],
    ),
  );

describe('Archive Explorer content detection', () => {
  it('recognizes images by signature, never by name, and PCX/TGA only with a valid header', () => {
    expect(sniffPreviewImage(bytes(0x89, 'PNG', 13, 10, 26, 10), 'photo.jpg')).toBe('png');
    expect(sniffPreviewImage(bytes(0xff, 0xd8, 0xff, 0xe0), 'x')).toBe('jpeg');
    expect(sniffPreviewImage(bytes('GIF89a'), 'x')).toBe('gif');
    expect(sniffPreviewImage(bytes('RIFF', 0, 0, 0, 0, 'WEBP'), 'x')).toBe('webp');
    expect(sniffPreviewImage(bytes('II*', 0), 'x')).toBe('tiff');
    expect(sniffPreviewImage(bytes('P6\n2 2\n255\n'), 'x')).toBe('ppm');
    expect(sniffPreviewImage(bytes('not an image at all'), 'image.png')).toBeNull();
    const pcx = new Uint8Array(128);
    pcx.set([10, 5, 1, 8], 0);
    pcx[8] = 9;
    pcx[10] = 9;
    pcx[65] = 1;
    expect(sniffPreviewImage(pcx, 'art.pcx')).toBe('pcx');
    expect(sniffPreviewImage(pcx, 'art.bin')).toBeNull();
    const tga = new Uint8Array(18);
    tga[2] = 2;
    tga[12] = 4;
    tga[14] = 4;
    tga[16] = 24;
    expect(sniffPreviewImage(tga, 'pic.tga')).toBe('tga');
    tga[16] = 7;
    expect(sniffPreviewImage(tga, 'pic.tga')).toBeNull();
  });

  it('calls text text whatever its name, and binary binary whatever its name', () => {
    expect(detectContent('README', bytes('Hello\n'))).toMatchObject({
      kind: 'text',
      language: null,
    });
    expect(detectContent('notes.unknownext', bytes('Hello\n')).kind).toBe('text');
    expect(detectContent('vm.cfg', bytes('[General]\n'))).toMatchObject({
      kind: 'text',
      language: 'ini',
    });
    expect(detectContent('readme.md', bytes('# Hi'))).toMatchObject({ kind: 'markdown' });
    expect(detectContent('page.html', bytes('<html>'))).toMatchObject({
      kind: 'text',
      format: 'xml',
    });
    expect(detectContent('logo.svg', bytes('<svg>'))).toMatchObject({
      kind: 'text',
      format: 'svg',
    });
    expect(detectContent('doc.pdf', bytes('%PDF-1.7'))).toMatchObject({ kind: 'pdf' });
    expect(detectContent('readme.txt', bytes('MZ', 0x90, 0, 3, 0))).toMatchObject({
      kind: 'binary',
    });
    // A ROM padded with 0xFF has no NUL, and is still not text.
    const rom = new Uint8Array(4096).fill(0xff);
    rom.set(bytes('IBM BIOS'), 0);
    expect(looksLikeText(rom)).toBe(false);
    // A DOS menu drawn with box characters is text.
    expect(
      looksLikeText(
        bytes(0xc9, ...Array(40).fill(0xcd), 0xbb, 13, 10, 0xba, ' Menu ', 0xba, 13, 10),
      ),
    ).toBe(true);
    expect(looksLikeText(new Uint8Array(0))).toBe(true);
  });

  it('detects encodings: BOM first, then UTF-16 by its zeros, strict UTF-8, then a guess', () => {
    expect(detectEncoding(bytes(0xef, 0xbb, 0xbf, 'x'))).toEqual({
      name: 'utf-8',
      confidence: 'bom',
    });
    expect(detectEncoding(bytes(0xff, 0xfe, 'x', 0))).toEqual({
      name: 'utf-16le',
      confidence: 'bom',
    });
    expect(detectEncoding(bytes(0xfe, 0xff, 0, 'x'))).toEqual({
      name: 'utf-16be',
      confidence: 'bom',
    });
    expect(detectEncoding(Buffer.from('Hello world, plain', 'utf16le'))).toEqual({
      name: 'utf-16le',
      confidence: 'heuristic',
    });
    expect(detectEncoding(Buffer.from('Grüße ✓'))).toEqual({ name: 'utf-8', confidence: 'valid' });
    // A UTF-8 preview cut inside a character is still UTF-8.
    expect(detectEncoding(Buffer.from('Grüße ✓').subarray(0, -1)).name).toBe('utf-8');
    expect(detectEncoding(bytes('He said ', 0x93, 'yes', 0x94, ' ', 0x96, ' caf', 0xe9)).name).toBe(
      'windows-1252',
    );
    expect(detectEncoding(bytes(0xc9, 0xcd, 0xcd, 0xbb, 13, 10, 0xba, 0x82, 0xba)).name).toBe(
      'cp437',
    );
    expect(detectEncoding(bytes('x', 0xe9, 'y'), 'readme.nfo').name).toBe('cp437');
  });

  it('decodes every supported encoding', () => {
    expect(CP437_HIGH).toHaveLength(128);
    expect(CP850_HIGH).toHaveLength(128);
    expect(decodeText(bytes(0x82, 0xc9, 0xdb, 0xe1), 'cp437')).toBe('é╔█ß');
    expect(decodeText(bytes(0x82, 0x9b, 0xc9, 0xd0), 'cp850')).toBe('éø╔ð');
    expect(decodeText(bytes(0x80, 0xe9), 'windows-1252')).toBe('€é');
    expect(decodeText(Buffer.from('Hé', 'utf16le'), 'utf-16le')).toBe('Hé');
    expect(decodeText(bytes(0, 'H', 0, 0xe9), 'utf-16be')).toBe('Hé');
    expect(decodeText(bytes(0xff), 'utf-8')).toBe('�');
  });

  it('names highlighting languages for common files', () => {
    expect(languageFor('AUTOEXEC.BAT')).toBe('dos');
    expect(languageFor('setup.PS1')).toBe('powershell');
    expect(languageFor('vm.ovf')).toBe('xml');
    expect(languageFor('Makefile')).toBe('makefile');
    expect(languageFor('notes.log')).toBeNull();
  });

  it('accepts only canonical, relative entry paths in requests', () => {
    expect(archiveEntryQuerySchema.parse({ path: 'docs/a.txt' })).toEqual({
      view: 'logical',
      path: 'docs/a.txt',
    });
    for (const path of ['', '/etc/passwd', '../x', 'a/../b']) {
      expect(archiveEntryQuerySchema.safeParse({ path }).success).toBe(false);
    }
    expect(archivePreviewQuerySchema.safeParse({ path: 'a', kind: 'html' }).success).toBe(false);
    expect(archivePreviewQuerySchema.parse({ path: 'a', kind: 'hex', offset: '16' }).offset).toBe(
      16,
    );
    expect(
      archivePreviewQuerySchema.safeParse({ path: 'a', kind: 'hex', offset: '-1' }).success,
    ).toBe(false);
  });
});
