import {
  Binary,
  Disc,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Link2,
  type LucideIcon,
} from 'lucide-react';
import { extensionOf } from '@emucat/contracts';
import { ICON_SIZE } from './IconButton';

/**
 * One icon per kind of file, decided in one place (decision 0058). The extension only suggests what a file is, so it
 * only chooses an icon: what a file is for previews comes from its bytes (decision 0056), and the icon follows that
 * once it is known (`detected`).
 */

export type FileIconKind =
  | 'directory'
  | 'directory-open'
  | 'archive'
  | 'text'
  | 'config'
  | 'code'
  | 'image'
  | 'document'
  | 'binary'
  | 'disk'
  | 'optical'
  | 'executable'
  | 'link'
  | 'unknown';

const ICONS: Record<FileIconKind, LucideIcon> = {
  directory: Folder,
  'directory-open': FolderOpen,
  archive: FileArchive,
  text: FileText,
  config: FileCog,
  code: FileCode,
  image: FileImage,
  document: FileText,
  binary: Binary,
  disk: HardDrive,
  optical: Disc,
  executable: FileTerminal,
  link: Link2,
  unknown: File,
};

const BY_EXTENSION: [FileIconKind, string[]][] = [
  [
    'archive',
    [
      'zip',
      'jar',
      'tar',
      'tgz',
      'gz',
      'ova',
      '7z',
      'rar',
      'bz2',
      'xz',
      'zst',
      'cab',
      'arj',
      'lzh',
      'lha',
      'arc',
      'zoo',
      'z',
    ],
  ],
  ['optical', ['iso', 'cue', 'mdf', 'mds', 'nrg', 'ccd', 'chd']],
  [
    'disk',
    [
      'img',
      'ima',
      'imz',
      'vfd',
      'flp',
      'dsk',
      'hdd',
      'hdf',
      'hdi',
      'hds',
      'raw',
      'vhd',
      'vhdx',
      'vdi',
      'vmdk',
      'qcow',
      'qcow2',
      'qed',
      '86f',
      'td0',
      'imd',
      'd88',
      'fdi',
    ],
  ],
  [
    'config',
    [
      'cfg',
      'ini',
      'conf',
      'config',
      'inf',
      'reg',
      'ovf',
      'vbox',
      'nvr',
      'json',
      'yaml',
      'yml',
      'toml',
      'xml',
      'mf',
      'pif',
    ],
  ],
  ['executable', ['exe', 'com', 'bat', 'cmd', 'sys', 'dll', 'drv', 'vxd', 'ovl', 'sh', 'ps1']],
  [
    'code',
    [
      'c',
      'h',
      'cpp',
      'hpp',
      'cc',
      'asm',
      's',
      'inc',
      'pas',
      'pp',
      'bas',
      'py',
      'js',
      'ts',
      'java',
      'rs',
      'go',
      'pl',
      'rb',
      'lua',
      'html',
      'htm',
      'css',
      'svg',
      'mak',
      'mk',
    ],
  ],
  [
    'image',
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'ppm', 'tif', 'tiff', 'pcx', 'tga'],
  ],
  ['document', ['pdf', 'doc', 'docx', 'rtf', 'wri']],
  ['text', ['txt', 'md', 'markdown', 'nfo', 'diz', 'log', 'me', '1st', 'doc', 'csv', 'asc']],
  ['binary', ['bin', 'rom', 'dat']],
];

const EXTENSION_KIND = new Map<string, FileIconKind>(
  BY_EXTENSION.flatMap(([kind, extensions]) =>
    extensions.map((extension) => [extension, kind] as const),
  ),
);

const SPECIAL_NAMES: Record<string, FileIconKind> = {
  'config.sys': 'config',
  'autoexec.bat': 'config',
  readme: 'text',
  makefile: 'code',
};

/** The icon kind for a file, from its name, refined by what its bytes turned out to be when known. */
export function fileIconKind(
  name: string,
  options: {
    directory?: boolean;
    open?: boolean;
    archive?: boolean;
    link?: boolean;
    detected?: string | null;
  } = {},
): FileIconKind {
  if (options.directory) return options.open ? 'directory-open' : 'directory';
  if (options.link) return 'link';
  if (options.archive) return 'archive';
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  const byName = SPECIAL_NAMES[base] ?? EXTENSION_KIND.get(extensionOf(base)) ?? 'unknown';
  switch (options.detected) {
    case 'image':
      return 'image';
    case 'pdf':
      return 'document';
    case 'markdown':
    case 'text':
      return byName === 'config' || byName === 'code' ? byName : 'text';
    case 'binary':
      return byName === 'text' || byName === 'unknown' ? 'binary' : byName;
    default:
      return byName;
  }
}

export function FileTypeIcon({
  kind,
  size = ICON_SIZE,
  className,
}: {
  kind: FileIconKind;
  size?: number;
  className?: string;
}) {
  const Icon = ICONS[kind];
  return (
    <Icon
      size={size}
      aria-hidden="true"
      className={`file-type-icon file-type-${kind} ${className ?? ''}`}
      data-icon={kind}
    />
  );
}
