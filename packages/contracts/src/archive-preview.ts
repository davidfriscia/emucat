import type { ArchiveContentKind } from './archive-inspection.js';

/**
 * What an archive file is, from its bytes, for Archive Explorer (decision 0056). Shared by the server, which decides
 * what it will prepare, and the browser, which decodes text locally so that changing the encoding needs no request.
 *
 * Signatures are believed over names. A name is used only for what has no signature: the highlighting language of
 * text, Markdown, and the two legacy image formats without a magic number (PCX and TGA), whose header must also be
 * valid.
 */

// --- Images ----------------------------------------------------------------------------------------------------

export const PREVIEW_IMAGE_FORMATS = [
  'png',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'ppm',
  'tiff',
  'pcx',
  'tga',
] as const;
export type PreviewImageFormat = (typeof PREVIEW_IMAGE_FORMATS)[number];

/** Formats a browser shows itself; the others are converted to PNG by the server, in memory. */
export const BROWSER_IMAGE_FORMATS: ReadonlySet<PreviewImageFormat> = new Set([
  'png',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
]);

export const PREVIEW_IMAGE_MIME: Readonly<Record<PreviewImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  ppm: 'image/x-portable-pixmap',
  tiff: 'image/tiff',
  pcx: 'image/x-pcx',
  tga: 'image/x-tga',
};

const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32le = (b: Uint8Array, at: number) => (u16le(b, at) | (u16le(b, at + 2) << 16)) >>> 0;

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function startsWith(head: Uint8Array, bytes: readonly number[], at = 0): boolean {
  if (head.length < at + bytes.length) return false;
  return bytes.every((byte, index) => head[at + index] === byte);
}

/** A PCX header (ZSoft): manufacturer 10, a known version, RLE, a plausible depth and window. */
function pcxHeader(head: Uint8Array): boolean {
  if (head.length < 128 || head[0] !== 0x0a || head[2] !== 1) return false;
  if (![0, 2, 3, 4, 5].includes(head[1] ?? -1)) return false;
  if (![1, 2, 4, 8].includes(head[3] ?? -1)) return false;
  const planes = head[65] ?? 0;
  if (planes < 1 || planes > 4) return false;
  return u16le(head, 8) >= u16le(head, 4) && u16le(head, 10) >= u16le(head, 6);
}

/** A TGA header: a known image type, a colour map that agrees with it, and a depth the type allows. */
function tgaHeader(head: Uint8Array): boolean {
  if (head.length < 18) return false;
  const colorMapType = head[1] ?? 0;
  const type = head[2] ?? 0;
  const depth = head[16] ?? 0;
  if (![1, 2, 3, 9, 10, 11].includes(type) || colorMapType > 1) return false;
  if ((type === 1 || type === 9) !== (colorMapType === 1)) return false;
  if (u16le(head, 12) === 0 || u16le(head, 14) === 0) return false;
  if (type === 3 || type === 11) return depth === 8;
  if (type === 1 || type === 9) return depth === 8;
  return depth === 15 || depth === 16 || depth === 24 || depth === 32;
}

/** The image format from the first bytes (at least 128 for PCX), or `null`. */
export function sniffPreviewImage(head: Uint8Array, name = ''): PreviewImageFormat | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39)) {
    return head[5] === 0x61 ? 'gif' : null;
  }
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp';
  }
  if (startsWith(head, [0x42, 0x4d]) && head.length >= 26) {
    const headerSize = u32le(head, 14);
    if ([12, 40, 52, 56, 64, 108, 124].includes(headerSize)) return 'bmp';
  }
  if (startsWith(head, [0, 0, 1, 0]) && head.length >= 22) {
    const count = u16le(head, 4);
    const offset = u32le(head, 18);
    if (count >= 1 && count <= 256 && offset >= 6 + 16 * count) return 'ico';
  }
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff';
  }
  if (head[0] === 0x50 && (head[1] === 0x36 || head[1] === 0x33)) {
    const next = head[2];
    if (next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d || next === 0x23) {
      return 'ppm';
    }
  }
  const extension = extensionOf(name);
  if (extension === 'pcx' && pcxHeader(head)) return 'pcx';
  if (['tga', 'icb', 'vda', 'vst'].includes(extension) && tgaHeader(head)) return 'tga';
  return null;
}

// --- Text ------------------------------------------------------------------------------------------------------

export const TEXT_ENCODINGS = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'windows-1252',
  'cp437',
  'cp850',
] as const;
export type TextEncoding = (typeof TEXT_ENCODINGS)[number];

export const TEXT_ENCODING_LABELS: Readonly<Record<TextEncoding, string>> = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1252': 'Windows-1252',
  cp437: 'CP437 (DOS, US)',
  cp850: 'CP850 (DOS, Western Europe)',
};

/** DOS code page 437, bytes 0x80–0xFF. */
export const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** DOS code page 850, bytes 0x80–0xFF. */
export const CP850_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';

/** How CP437 draws the control bytes 0x00–0x1F and 0x7F on screen, for the hex view. */
export const CP437_CONTROL_GLYPHS = ' ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼';
export const CP437_DELETE_GLYPH = '⌂';

function decodeCodePage(bytes: Uint8Array, high: string): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 4096) {
    const slice = bytes.subarray(index, index + 4096);
    let part = '';
    for (const byte of slice) part += byte < 0x80 ? String.fromCharCode(byte) : high[byte - 0x80];
    text += part;
  }
  return text;
}

/** Text from bytes. Never throws: what cannot be decoded becomes U+FFFD. */
export function decodeText(bytes: Uint8Array, encoding: TextEncoding): string {
  if (encoding === 'cp437') return decodeCodePage(bytes, CP437_HIGH);
  if (encoding === 'cp850') return decodeCodePage(bytes, CP850_HIGH);
  return new TextDecoder(encoding, { fatal: false }).decode(bytes);
}

function validUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    // A preview may end inside a character: one cut sequence at the very end is allowed.
    for (let back = 1; back <= 3 && back < bytes.length; back += 1) {
      const lead = bytes[bytes.length - back] ?? 0;
      if ((lead & 0xc0) === 0xc0) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - back));
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  }
}

/** UTF-16 without a byte-order mark: ASCII-heavy text has a zero in every other byte. */
function utf16Without(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const sample = bytes.subarray(0, Math.min(bytes.length, 1024) & ~1);
  if (sample.length < 8) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let index = 0; index < sample.length; index += 2) {
    if (sample[index] === 0) evenZero += 1;
    if (sample[index + 1] === 0) oddZero += 1;
  }
  const pairs = sample.length / 2;
  if (oddZero >= pairs * 0.9 && evenZero <= pairs * 0.05) return 'utf-16le';
  if (evenZero >= pairs * 0.9 && oddZero <= pairs * 0.05) return 'utf-16be';
  return null;
}

export interface DetectedEncoding {
  name: TextEncoding;
  /** `bom`: a byte-order mark said so. `valid`: strictly valid UTF-8. `heuristic`: a guess from byte frequencies. */
  confidence: 'bom' | 'valid' | 'heuristic';
}

/** Bytes typical of Windows-1252 text and rare in DOS text: curly quotes, dashes, the ellipsis, the euro. */
const WINDOWS_PUNCTUATION = new Set([0x80, 0x85, 0x91, 0x92, 0x93, 0x94, 0x96, 0x97, 0x99]);
/** Not assigned in Windows-1252 at all. */
const WINDOWS_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/**
 * The likely encoding: a byte-order mark first, then UTF-16 by its zeros, then strict UTF-8, and only then a guess
 * between Windows-1252 and DOS code page 437 from which high bytes occur. CP850 is never guessed: it differs from
 * CP437 mostly in letters both use rarely, so it is offered for manual selection only.
 */
export function detectEncoding(bytes: Uint8Array, name = ''): DetectedEncoding {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return { name: 'utf-8', confidence: 'bom' };
  if (startsWith(bytes, [0xff, 0xfe])) return { name: 'utf-16le', confidence: 'bom' };
  if (startsWith(bytes, [0xfe, 0xff])) return { name: 'utf-16be', confidence: 'bom' };
  const wide = utf16Without(bytes);
  if (wide) return { name: wide, confidence: 'heuristic' };
  if (validUtf8(bytes)) return { name: 'utf-8', confidence: 'valid' };
  let dos = 0;
  let windows = 0;
  for (const byte of bytes) {
    if (byte < 0x80) {
      if (byte === 0x1a) dos += 2;
      continue;
    }
    if (WINDOWS_UNDEFINED.has(byte)) dos += 5;
    else if (WINDOWS_PUNCTUATION.has(byte)) windows += 2;
    else if (byte >= 0xb0 && byte <= 0xdf) dos += 2;
    else if (byte >= 0xe0) windows += 1;
    else if (byte < 0xa0) dos += 1;
  }
  if (['nfo', 'diz', 'ans', 'asc'].includes(extensionOf(name))) dos += 4;
  return { name: dos > windows ? 'cp437' : 'windows-1252', confidence: 'heuristic' };
}

/** Control bytes that ordinary text, DOS text included, does contain. */
const TEXT_CONTROLS = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x1a, 0x1b]);

/**
 * Whether bytes are text in any supported encoding. No NUL (except in UTF-16), and almost no other control bytes:
 * a binary file is not called text because of its name, and a text file with any name is.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return true;
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return true;
  if (utf16Without(bytes)) return true;
  let controls = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    if ((byte < 0x20 && !TEXT_CONTROLS.has(byte)) || byte === 0x7f) controls += 1;
  }
  return controls <= bytes.length * 0.01;
}

// --- Languages -------------------------------------------------------------------------------------------------

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  inf: 'ini',
  reg: 'ini',
  toml: 'ini',
  desktop: 'ini',
  bat: 'dos',
  cmd: 'dos',
  sys: 'dos',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  xml: 'xml',
  ovf: 'xml',
  vbox: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  svg: 'xml',
  plist: 'xml',
  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  css: 'css',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  java: 'java',
  py: 'python',
  rb: 'ruby',
  pl: 'perl',
  rs: 'rust',
  go: 'go',
  sql: 'sql',
  asm: 'x86asm',
  inc: 'x86asm',
  bas: 'basic',
  pas: 'delphi',
  pp: 'delphi',
  dpr: 'delphi',
  diff: 'diff',
  patch: 'diff',
  properties: 'properties',
  md: 'markdown',
  markdown: 'markdown',
  mk: 'makefile',
  vbs: 'vbscript',
  lua: 'lua',
  tcl: 'tcl',
};

/** The highlight.js language for a file name, or `null` for plain text. */
export function languageFor(name: string): string | null {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile';
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'config.sys' || base === 'autoexec.bat') return 'dos';
  return LANGUAGE_BY_EXTENSION[extensionOf(base)] ?? null;
}

export function isMarkdownName(name: string): boolean {
  return ['md', 'markdown', 'mdown', 'mkd'].includes(extensionOf(name));
}

export interface DetectedContent {
  kind: ArchiveContentKind;
  format: string;
  language: string | null;
  encoding: DetectedEncoding | null;
}

/** What a file is, from its first bytes (a few KiB are enough) and its name. */
export function detectContent(name: string, head: Uint8Array): DetectedContent {
  const image = sniffPreviewImage(head, name);
  if (image) return { kind: 'image', format: image, language: null, encoding: null };
  const pdfAt = findPdfHeader(head);
  if (pdfAt >= 0) return { kind: 'pdf', format: 'pdf', language: null, encoding: null };
  if (looksLikeText(head)) {
    const encoding = detectEncoding(head, name);
    if (isMarkdownName(name)) {
      return { kind: 'markdown', format: 'markdown', language: 'markdown', encoding };
    }
    const language = languageFor(name);
    const format = extensionOf(name) === 'svg' ? 'svg' : language === 'xml' ? 'xml' : 'text';
    return { kind: 'text', format, language, encoding };
  }
  return { kind: 'binary', format: 'binary', language: null, encoding: null };
}

/** PDF readers accept `%PDF-` anywhere in the first 1024 bytes. */
export function findPdfHeader(head: Uint8Array): number {
  const limit = Math.min(head.length, 1024) - 5;
  for (let index = 0; index <= limit; index += 1) {
    if (
      head[index] === 0x25 &&
      head[index + 1] === 0x50 &&
      head[index + 2] === 0x44 &&
      head[index + 3] === 0x46 &&
      head[index + 4] === 0x2d
    ) {
      return index;
    }
  }
  return -1;
}
