import type {
  ArchiveEntry,
  ArchiveListingResponse,
  ArchiveView,
  VmIdentity,
} from '@emucat/contracts';
import { ChevronDown, ChevronRight, LoaderCircle, Search, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { downloadArchiveFile, fetchArchiveEntries, fetchArchiveEntry } from '../../api';
import type { LocalArchiveClient } from '../../archive-local/client';
import {
  archiveFormatFromName,
  isDiskImageName,
  unsupportedArchiveFromName,
} from '../../archive-local/detect';
import { LocalArchiveError, depthLimitError } from '../../archive-local/errors';
import type { OpenResult } from '../../archive-local/host';
import type { LocalEntry } from '../../archive-local/model';
import { formatBytes } from '../Agents';
import { FileTypeIcon, fileIconKind } from '../ui/FileTypeIcon';
import { IconButton, ICON_SIZE } from '../ui/IconButton';
import { problemText } from './problems';
import {
  nestedSource,
  remoteSource,
  type Crumb,
  type FileSource,
  type NestedContainer,
} from './source';

/**
 * The left panel of Archive Explorer (decisions 0056 and 0058): an expandable tree of the version's archive, whose
 * directories the server lists one at a time, as they are opened, and in pages. An archive found in it (ZIP, TAR,
 * OVA, GZIP, TAR.GZ) is a node of its own: selecting it shows it as a file; expanding it downloads that one file
 * through the existing single-file API, once, and the browser's archive worker reads what it holds. Archives inside
 * it open the same way, from the bytes the worker already has, up to five levels deep.
 *
 * Row identities never depend on a name an archive chose: a server row is its path in the version's archive (exact,
 * as the server listed it), a nested row is its archive's id and its entry's position, and a nested directory is
 * its archive's id and its path. `\0`, which no path holds, separates the parts.
 *
 * Keyboard, as the WAI-ARIA tree pattern: Up and Down move, Right opens a directory or an archive or enters it,
 * Left closes it or goes to its parent, Home and End jump, Enter or Space selects a file or opens a directory.
 */

const PAGE_SIZE = 200;

interface DirectoryState {
  entries: ArchiveEntry[];
  total: number;
  nextOffset: number | null;
  loading: boolean;
  error: unknown;
}

interface LocalDirectory {
  dirs: string[];
  files: number[];
}

/** A nested archive in this tree: where it sits, and what was read of it. */
interface NestedNode {
  hostKey: string;
  name: string;
  /** The archive it is in, or `null` for one in the version's archive itself. */
  parentArchiveId: string | null;
  parentEntryIndex: number | null;
  /** Its path in the version's archive, for one opened from there. */
  remotePath: string | null;
  status: 'loading' | 'ready' | 'error';
  progress: { received: number; total: number } | null;
  error: unknown;
  opened: OpenResult | null;
  directories: Map<string, LocalDirectory> | null;
  shown: Map<string, number>;
}

type Expandable = 'directory' | 'archive' | null;

type Row =
  | {
      kind: 'remote';
      key: string;
      entry: ArchiveEntry;
      level: number;
      label: string;
      expandable: Expandable;
    }
  | {
      kind: 'local';
      key: string;
      archiveId: string;
      entry: LocalEntry;
      level: number;
      label: string;
      expandable: Expandable;
    }
  | {
      kind: 'local-dir';
      key: string;
      archiveId: string;
      path: string;
      level: number;
      label: string;
    }
  | { kind: 'action'; key: string; level: number; text: string; run: () => void }
  | { kind: 'status'; key: string; level: number; text: string; problem: boolean; busy?: boolean };

const SEP = '\0';
export const remoteKey = (path: string) => `R${SEP}${path}`;
const localFileKey = (archiveId: string, index: number) => `L${SEP}${archiveId}${SEP}#${index}`;
const localDirKey = (archiveId: string, path: string) => `L${SEP}${archiveId}${SEP}/${path}`;

/** Row keys hold `\0`, which an attribute should not: the DOM sees them encoded. */
const domKey = (key: string) => encodeURIComponent(key);
const rowElement = (tree: HTMLElement | null, key: string) =>
  tree?.querySelector<HTMLElement>(`[data-key="${CSS.escape(domKey(key))}"]`) ?? null;

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** An archive the browser may open, judging by its name only; the bytes decide once it is opened. */
export function isArchiveCandidate(name: string): boolean {
  return archiveFormatFromName(name) !== null && !isDiskImageName(name);
}

function buildDirectories(entries: readonly LocalEntry[]): Map<string, LocalDirectory> {
  const directories = new Map<string, LocalDirectory>([['', { dirs: [], files: [] }]]);
  const ensure = (path: string): LocalDirectory => {
    let directory = directories.get(path);
    if (directory) return directory;
    directory = { dirs: [], files: [] };
    directories.set(path, directory);
    const parent = ensure(parentOf(path));
    parent.dirs.push(path);
    return directory;
  };
  for (const entry of entries) {
    if (entry.unsafePath) {
      (directories.get('') as LocalDirectory).files.push(entry.index);
    } else if (entry.type === 'directory') {
      ensure(entry.path);
    } else {
      ensure(parentOf(entry.path)).files.push(entry.index);
    }
  }
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  for (const directory of directories.values()) {
    directory.dirs.sort((a, b) => collator.compare(nameOf(a), nameOf(b)));
    directory.files.sort((a, b) => {
      const left = entries[a] as LocalEntry;
      const right = entries[b] as LocalEntry;
      return collator.compare(left.name, right.name) || a - b;
    });
  }
  return directories;
}

const FORMAT_LABEL: Record<string, string> = {
  zip: 'ZIP',
  tar: 'TAR',
  ova: 'OVA',
  gzip: 'GZIP',
  'tar.gz': 'TAR.GZ',
};

export interface TreeRequest {
  /** A row to show: its parents are opened and it is focused. */
  key: string;
  /** Also open it, when it is an archive. */
  open: boolean;
  nonce: number;
}

export function ArchiveTree({
  vm,
  versionId,
  view,
  rootLabel,
  client,
  pinned,
  selectedKey,
  onSelect,
  request,
}: {
  vm: VmIdentity;
  versionId: string;
  view: ArchiveView;
  rootLabel: string;
  client: LocalArchiveClient;
  /** Archive ids in use (the ancestors of the file shown), which the cache must keep. */
  pinned: { current: string[] };
  selectedKey: string | null;
  onSelect: (source: FileSource) => void;
  request: TreeRequest | null;
}) {
  const ids = useId();
  const { emulatorType, vmName } = vm;
  const [directories, setDirectories] = useState<Map<string, DirectoryState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [nested, setNested] = useState<Map<string, NestedNode>>(new Map());
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<'outer' | 'loaded'>('outer');
  const [query, setQuery] = useState<{ text: string; scope: 'outer' | 'loaded' } | null>(null);
  const [results, setResults] = useState<DirectoryState | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const controllers = useRef(new Set<AbortController>());
  const opening = useRef(new Map<string, AbortController>());
  const tree = useRef<HTMLDivElement>(null);
  const nestedRef = useRef(nested);
  useEffect(() => {
    nestedRef.current = nested;
  }, [nested]);

  useEffect(() => {
    const active = controllers.current;
    const opens = opening.current;
    return () => {
      for (const controller of active) controller.abort();
      for (const controller of opens.values()) controller.abort();
    };
  }, []);

  /** Archives the worker no longer holds: their branches close, and say why. */
  useEffect(
    () =>
      client.onReleased((released) => {
        const gone = new Set(released);
        const lost = [...nestedRef.current.values()].filter(
          (node) => node.opened && gone.has(node.opened.id),
        );
        if (lost.length === 0) return;
        const lostKeys = new Set(lost.map((node) => node.hostKey));
        const prefixes = lost.map((node) => `L${SEP}${node.opened?.id}${SEP}`);
        setNested((current) => {
          const next = new Map(current);
          for (const key of lostKeys) next.delete(key);
          for (const key of [...next.keys()]) {
            if (prefixes.some((prefix) => key.startsWith(prefix))) next.delete(key);
          }
          return next;
        });
        setExpanded((current) => {
          const next = new Set(current);
          for (const key of current) {
            if (lostKeys.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))
              next.delete(key);
          }
          return next;
        });
        setAnnouncement(
          `${lost.map((node) => node.name).join(', ')} ${lost.length === 1 ? 'was' : 'were'} released to free memory. Expand again to reload.`,
        );
      }),
    [client],
  );

  const fetchPage = useCallback(
    async (options: {
      path?: string;
      q?: string;
      offset: number;
    }): Promise<ArchiveListingResponse> => {
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        return await fetchArchiveEntries(
          { emulatorType, vmName },
          versionId,
          { view, path: options.path, q: options.q, offset: options.offset, limit: PAGE_SIZE },
          controller.signal,
        );
      } finally {
        controllers.current.delete(controller);
      }
    },
    [emulatorType, vmName, versionId, view],
  );

  const loadDirectory = useCallback(
    async (path: string, offset = 0) => {
      setDirectories((current) => {
        const next = new Map(current);
        const previous = current.get(path);
        next.set(path, {
          entries: previous?.entries ?? [],
          total: previous?.total ?? 0,
          nextOffset: previous?.nextOffset ?? null,
          loading: true,
          error: null,
        });
        return next;
      });
      try {
        const page = await fetchPage({ path, offset });
        setDirectories((current) => {
          const next = new Map(current);
          const previous = offset > 0 ? (current.get(path)?.entries ?? []) : [];
          next.set(path, {
            entries: [...previous, ...page.entries],
            total: page.total,
            nextOffset: page.nextOffset,
            loading: false,
            error: null,
          });
          return next;
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        setDirectories((current) => {
          const next = new Map(current);
          const previous = current.get(path);
          next.set(path, {
            entries: previous?.entries ?? [],
            total: previous?.total ?? 0,
            nextOffset: previous?.nextOffset ?? null,
            loading: false,
            error,
          });
          return next;
        });
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    void loadDirectory('');
  }, [loadDirectory]);

  const loadResults = useCallback(
    async (q: string, offset = 0) => {
      setResults((current) => ({
        entries: offset > 0 ? (current?.entries ?? []) : [],
        total: current?.total ?? 0,
        nextOffset: current?.nextOffset ?? null,
        loading: true,
        error: null,
      }));
      try {
        const page = await fetchPage({ q, offset });
        setResults((current) => ({
          entries: [...(offset > 0 ? (current?.entries ?? []) : []), ...page.entries],
          total: page.total,
          nextOffset: page.nextOffset,
          loading: false,
          error: null,
        }));
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        setResults((current) => ({
          entries: current?.entries ?? [],
          total: current?.total ?? 0,
          nextOffset: null,
          loading: false,
          error,
        }));
      }
    },
    [fetchPage],
  );

  // --- Nested archives --------------------------------------------------------------------------------------

  const byArchiveId = useMemo(() => {
    const map = new Map<string, NestedNode>();
    for (const node of nested.values()) if (node.opened) map.set(node.opened.id, node);
    return map;
  }, [nested]);

  const updateNode = (hostKey: string, change: Partial<NestedNode>) =>
    setNested((current) => {
      const node = current.get(hostKey);
      if (!node) return current;
      const next = new Map(current);
      next.set(hostKey, { ...node, ...change });
      return next;
    });

  /** The archive ids from the outermost nested archive to `archiveId`. */
  const archiveChain = useCallback(
    (archiveId: string | null): NestedNode[] => {
      const chain: NestedNode[] = [];
      for (let at = archiveId; at !== null;) {
        const node = byArchiveId.get(at);
        if (!node) break;
        chain.unshift(node);
        at = node.parentArchiveId;
      }
      return chain;
    },
    [byArchiveId],
  );

  const openArchive = (
    hostKey: string,
    host: {
      name: string;
      size: number;
      remotePath: string | null;
      parent: { id: string; index: number } | null;
    },
  ) => {
    opening.current.get(hostKey)?.abort();
    const controller = new AbortController();
    opening.current.set(hostKey, controller);
    const { signal } = controller;
    setNested((current) =>
      new Map(current).set(hostKey, {
        hostKey,
        name: host.name,
        parentArchiveId: host.parent?.id ?? null,
        parentEntryIndex: host.parent?.index ?? null,
        remotePath: host.remotePath,
        status: 'loading',
        progress: null,
        error: null,
        opened: null,
        directories: null,
        shown: new Map(),
      }),
    );
    const parentDepth = host.parent ? (byArchiveId.get(host.parent.id)?.opened?.depth ?? 0) : 0;
    const chainIds = archiveChain(host.parent?.id ?? null).map((node) => node.opened?.id as string);
    void (async () => {
      let release: (() => void) | null = null;
      try {
        if (parentDepth + 1 > client.limits.maxDepth) throw depthLimitError(client.limits.maxDepth);
        if (host.size > client.limits.maxArchiveBytes) {
          throw new LocalArchiveError(
            'archive_too_large',
            `This archive is ${formatBytes(host.size)}; the browser opens archives inside an archive up to ${formatBytes(client.limits.maxArchiveBytes)}.`,
          );
        }
        release = await client.acquireOpenSlot(signal);
        let opened: OpenResult;
        const id = client.newId();
        if (host.remotePath !== null) {
          const file = { view, path: host.remotePath };
          const details = await fetchArchiveEntry(
            { emulatorType, vmName },
            versionId,
            file,
            signal,
          );
          if (!details.download.allowed) {
            throw new LocalArchiveError(
              'archive_too_large',
              details.download.maxBytes === 0
                ? 'Single-file downloads are turned off on this server, so this archive cannot be opened here.'
                : `This archive is larger than the server sends one file at a time (${formatBytes(details.download.maxBytes)}), so it cannot be opened here.`,
            );
          }
          // The one transfer: this file, whole, through the existing single-file download, verified by the server.
          const blob = await downloadArchiveFile({ emulatorType, vmName }, versionId, file, {
            signal,
            onProgress: (received, total) => updateNode(hostKey, { progress: { received, total } }),
          });
          const bytes = await blob.arrayBuffer();
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          opened = await client.open(
            { id, name: host.name, bytes, pinned: [...pinned.current] },
            signal,
          );
        } else {
          const parent = host.parent as { id: string; index: number };
          opened = await client.open(
            {
              id,
              name: host.name,
              parent: { id: parent.id, entryIndex: parent.index },
              pinned: [...new Set([...pinned.current, ...chainIds])],
            },
            signal,
          );
        }
        if (signal.aborted) return;
        updateNode(hostKey, {
          status: 'ready',
          opened,
          progress: null,
          directories: buildDirectories(opened.index.entries),
        });
        setAnnouncement(
          `${host.name} opened: ${opened.index.entries.length} ${opened.index.entries.length === 1 ? 'entry' : 'entries'}.`,
        );
      } catch (error) {
        if (signal.aborted) return;
        updateNode(hostKey, { status: 'error', error, progress: null });
      } finally {
        release?.();
        if (opening.current.get(hostKey) === controller) opening.current.delete(hostKey);
      }
    })();
  };

  /** What the browser needs to open the archive a row stands for, or `null` if it is not one. */
  const archiveHost = (row: Row) => {
    if (row.kind === 'remote' && row.expandable === 'archive') {
      return {
        name: row.entry.name,
        size: row.entry.sizeBytes ?? 0,
        remotePath: row.entry.path,
        parent: null,
      };
    }
    if (row.kind === 'local' && row.expandable === 'archive') {
      return {
        name: row.entry.name,
        size: row.entry.sizeBytes,
        remotePath: null,
        parent: { id: row.archiveId, index: row.entry.index },
      };
    }
    return null;
  };

  const setOpen = (key: string, open: boolean) =>
    setExpanded((current) => {
      if (current.has(key) === open) return current;
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  const toggleRow = (row: Row, open?: boolean) => {
    const opening_ = open ?? !expanded.has(row.key);
    if (row.kind === 'remote' && row.expandable === 'directory') {
      setOpen(row.key, opening_);
      if (opening_ && !directories.has(row.entry.path)) void loadDirectory(row.entry.path);
      return;
    }
    if (row.kind === 'local-dir') {
      setOpen(row.key, opening_);
      return;
    }
    const host = archiveHost(row);
    if (!host) return;
    setOpen(row.key, opening_);
    const node = nested.get(row.key);
    if (!opening_) {
      // Collapsing an archive that is still opening stops it; one that is open stays in memory for later.
      if (node?.status === 'loading') {
        opening.current.get(row.key)?.abort();
        setNested((current) => {
          const next = new Map(current);
          next.delete(row.key);
          return next;
        });
      }
      return;
    }
    if (!node || node.status === 'error') openArchive(row.key, host);
  };

  // --- Rows -------------------------------------------------------------------------------------------------

  const remoteExpandable = (entry: ArchiveEntry): Expandable =>
    entry.type === 'directory' ? 'directory' : isArchiveCandidate(entry.name) ? 'archive' : null;
  const localExpandable = (entry: LocalEntry): Expandable =>
    entry.type === 'file' && entry.archive && !entry.problem ? 'archive' : null;

  const rows: Row[] = [];
  const pushNested = (hostKey: string, level: number) => {
    const node = nested.get(hostKey);
    if (!node) return;
    if (node.status === 'loading') {
      rows.push({
        kind: 'status',
        key: `${hostKey}${SEP}loading`,
        level,
        busy: true,
        problem: false,
        text: node.progress
          ? `Downloading ${node.name}: ${formatBytes(node.progress.received)} of ${formatBytes(node.progress.total || 0)}`
          : `Opening ${node.name}…`,
      });
      return;
    }
    if (node.status === 'error') {
      rows.push({
        kind: 'status',
        key: `${hostKey}${SEP}error`,
        level,
        problem: true,
        text: problemText(node.error, 'The archive could not be opened.'),
      });
      const retryable =
        !(node.error instanceof LocalArchiveError) ||
        ![
          'depth_limit',
          'unsupported_format',
          'malformed',
          'truncated',
          'multi_volume',
          'archive_too_large',
          'too_many_entries',
        ].includes(node.error.code);
      if (retryable) {
        rows.push({
          kind: 'action',
          key: `${hostKey}${SEP}retry`,
          level,
          text: `Try opening ${node.name} again`,
          run: () => {
            const host = {
              name: node.name,
              size: 0,
              remotePath: node.remotePath,
              parent: node.parentArchiveId
                ? { id: node.parentArchiveId, index: node.parentEntryIndex as number }
                : null,
            };
            openArchive(hostKey, host);
          },
        });
      }
      return;
    }
    if (!node.opened || !node.directories) return;
    walkLocal(node, '', level);
  };

  const walkLocal = (node: NestedNode, path: string, level: number) => {
    const opened = node.opened as OpenResult;
    const directory = node.directories?.get(path);
    if (!directory) return;
    const archiveId = opened.id;
    const children: ({ dir: string } | { index: number })[] = [
      ...directory.dirs.map((dir) => ({ dir })),
      ...directory.files.map((index) => ({ index })),
    ];
    const shown = node.shown.get(path) ?? PAGE_SIZE;
    for (const child of children.slice(0, shown)) {
      if ('dir' in child) {
        const key = localDirKey(archiveId, child.dir);
        rows.push({
          kind: 'local-dir',
          key,
          archiveId,
          path: child.dir,
          level,
          label: nameOf(child.dir),
        });
        if (expanded.has(key)) walkLocal(node, child.dir, level + 1);
      } else {
        const entry = opened.index.entries[child.index] as LocalEntry;
        const key = localFileKey(archiveId, entry.index);
        const expandable = localExpandable(entry);
        rows.push({ kind: 'local', key, archiveId, entry, level, label: entry.name, expandable });
        if (expandable && expanded.has(key)) pushNested(key, level + 1);
      }
    }
    if (children.length > shown) {
      rows.push({
        kind: 'action',
        key: `${localDirKey(archiveId, path)}${SEP}more`,
        level,
        text: `Show more (${shown} of ${children.length})`,
        run: () =>
          setNested((current) => {
            const latest = current.get(node.hostKey);
            if (!latest) return current;
            const next = new Map(current);
            next.set(node.hostKey, {
              ...latest,
              shown: new Map(latest.shown).set(path, shown + PAGE_SIZE),
            });
            return next;
          }),
      });
    } else if (children.length === 0 && path === '') {
      rows.push({
        kind: 'status',
        key: `${node.hostKey}${SEP}empty`,
        level,
        text: 'Empty archive',
        problem: false,
      });
    }
  };

  if (query === null) {
    const walk = (path: string, level: number) => {
      const state = directories.get(path);
      if (!state) return;
      for (const entry of state.entries) {
        const key = remoteKey(entry.path);
        const expandable = remoteExpandable(entry);
        rows.push({ kind: 'remote', key, entry, level, label: entry.name, expandable });
        if (expandable === 'directory' && expanded.has(key)) walk(entry.path, level + 1);
        if (expandable === 'archive' && expanded.has(key)) pushNested(key, level + 1);
      }
      if (state.loading) {
        rows.push({
          kind: 'status',
          key: `${path}${SEP}loading`,
          level,
          text: 'Loading…',
          problem: false,
        });
      } else if (state.error) {
        rows.push({
          kind: 'status',
          key: `${path}${SEP}error`,
          level,
          text: problemText(state.error),
          problem: true,
        });
      } else if (state.nextOffset !== null) {
        rows.push({
          kind: 'action',
          key: `${path}${SEP}more`,
          level,
          text: `Show more (${state.entries.length} of ${state.total})`,
          run: () => void loadDirectory(path, state.entries.length),
        });
      } else if (state.entries.length === 0) {
        rows.push({
          kind: 'status',
          key: `${path}${SEP}empty`,
          level,
          text: 'Empty',
          problem: false,
        });
      }
    };
    walk('', 1);
  } else if (query.scope === 'outer' && results) {
    for (const entry of results.entries) {
      rows.push({
        kind: 'remote',
        key: remoteKey(entry.path),
        entry,
        level: 1,
        label: entry.path,
        expandable: null,
      });
    }
    if (results.loading)
      rows.push({
        kind: 'status',
        key: `${SEP}loading`,
        level: 1,
        text: 'Searching…',
        problem: false,
      });
    else if (results.error)
      rows.push({
        kind: 'status',
        key: `${SEP}error`,
        level: 1,
        text: problemText(results.error),
        problem: true,
      });
    else if (results.nextOffset !== null)
      rows.push({
        kind: 'action',
        key: `${SEP}more`,
        level: 1,
        text: `Show more (${results.entries.length} of ${results.total})`,
        run: () => void loadResults(query.text, results.entries.length),
      });
  }

  // Search of the archives opened in the browser: only what is already loaded is searched, never anything else.
  const localResults = useMemo(() => {
    if (query?.scope !== 'loaded') return null;
    const needle = query.text.toLowerCase();
    const found: { node: NestedNode; entry: LocalEntry }[] = [];
    let total = 0;
    for (const node of nested.values()) {
      if (node.status !== 'ready' || !node.opened) continue;
      for (const entry of node.opened.index.entries) {
        if (entry.type === 'directory' || !entry.path.toLowerCase().includes(needle)) continue;
        total += 1;
        if (found.length < 500) found.push({ node, entry });
      }
    }
    return { found, total };
  }, [query, nested]);
  if (localResults) {
    for (const { node, entry } of localResults.found) {
      const chain = archiveChain(node.opened?.id ?? null).map((item) => item.name);
      rows.push({
        kind: 'local',
        key: localFileKey(node.opened?.id as string, entry.index),
        archiveId: node.opened?.id as string,
        entry,
        level: 1,
        label: [...chain, entry.path].join(' › '),
        expandable: null,
      });
    }
  }
  const loadedArchives = [...nested.values()].filter((node) => node.status === 'ready').length;

  // --- Locations ---------------------------------------------------------------------------------------------

  /** The row keys of everything above a row, outermost first. */
  const ancestorsOf = useCallback(
    (key: string): string[] => {
      if (key.startsWith(`R${SEP}`)) {
        const chain: string[] = [];
        for (let at = parentOf(key.slice(2)); at !== ''; at = parentOf(at))
          chain.unshift(remoteKey(at));
        return chain;
      }
      const [, archiveId = '', rest = ''] = key.split(SEP);
      const node = byArchiveId.get(archiveId);
      if (!node) return [];
      const path = rest.startsWith('#')
        ? (node.opened?.index.entries[Number(rest.slice(1))] as LocalEntry | undefined)
        : null;
      const localPath = rest.startsWith('/')
        ? rest.slice(1)
        : path && !path.unsafePath
          ? path.path
          : '';
      const dirs: string[] = [];
      for (let at = parentOf(localPath); at !== ''; at = parentOf(at))
        dirs.unshift(localDirKey(archiveId, at));
      return [...ancestorsOf(node.hostKey), node.hostKey, ...dirs];
    },
    [byArchiveId],
  );

  const crumbsFor = useCallback(
    (key: string, label: string): Crumb[] => {
      const crumbs: Crumb[] = [{ label: rootLabel, kind: 'root', rowKey: null }];
      for (const ancestor of ancestorsOf(key)) {
        const node = nested.get(ancestor);
        if (node) crumbs.push({ label: node.name, kind: 'archive', rowKey: ancestor });
        else if (ancestor.startsWith(`R${SEP}`)) {
          crumbs.push({ label: nameOf(ancestor.slice(2)), kind: 'directory', rowKey: ancestor });
        } else {
          crumbs.push({
            label: nameOf(ancestor.split(SEP)[2]?.slice(1) ?? ''),
            kind: 'directory',
            rowKey: ancestor,
          });
        }
      }
      crumbs.push({ label, kind: 'file', rowKey: key });
      return crumbs;
    },
    [ancestorsOf, nested, rootLabel],
  );

  const reveal = (key: string, open = false) => {
    setQuery(null);
    setSearch('');
    const chain = ancestorsOf(key);
    setExpanded((current) => new Set([...current, ...chain, ...(open ? [key] : [])]));
    for (const ancestor of chain) {
      if (ancestor.startsWith(`R${SEP}`)) {
        const path = ancestor.slice(2);
        if (!directories.has(path)) void loadDirectory(path);
      }
    }
    setFocusKey(key);
    requestAnimationFrame(() => {
      rowElement(tree.current, key)?.focus();
    });
  };

  // A breadcrumb or the file panel asked to show (and perhaps open) a row.
  const lastRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!request || request.nonce === lastRequest.current) return;
    lastRequest.current = request.nonce;
    reveal(request.key, false);
    if (request.open) {
      const row = rows.find((candidate) => candidate.key === request.key);
      if (row && !expanded.has(row.key)) toggleRow(row, true);
      else if (!row) setExpanded((current) => new Set([...current, request.key]));
    }
    // Only a new request is acted on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // --- Selection ---------------------------------------------------------------------------------------------

  const sourceFor = (row: Extract<Row, { kind: 'remote' | 'local' }>): FileSource => {
    // In search results the row does not expand, but the file is still an archive the tree can open.
    const candidate =
      row.kind === 'remote'
        ? remoteExpandable(row.entry) === 'archive'
        : localExpandable(row.entry) === 'archive';
    const archiveRowKey = candidate ? row.key : null;
    if (row.kind === 'remote') {
      return remoteSource({
        vm,
        versionId,
        view,
        entry: row.entry,
        rowKey: row.key,
        location: crumbsFor(row.key, row.entry.name),
        archiveRowKey,
      });
    }
    const chainNodes = archiveChain(row.archiveId);
    const node = chainNodes.at(-1) as NestedNode;
    const opened = node.opened as OpenResult;
    const container: NestedContainer = {
      archiveId: opened.id,
      name: node.name,
      format: opened.index.format,
      depth: opened.depth,
      payloadBytes: opened.payloadBytes,
      checksummed: opened.index.checksummed,
      chain: [
        ...(chainNodes[0]?.remotePath ? [chainNodes[0].remotePath] : []),
        ...chainNodes.slice(chainNodes[0]?.remotePath ? 1 : 0).map((item) => item.name),
      ],
      archiveIds: chainNodes.map((item) => item.opened?.id as string),
    };
    return nestedSource({
      client,
      view,
      container,
      entry: row.entry,
      rowKey: row.key,
      location: crumbsFor(row.key, row.entry.name),
      archiveRowKey,
    });
  };

  const focusable = rows.filter((row) => row.kind !== 'status');
  const activeKey =
    focusKey && focusable.some((row) => row.key === focusKey)
      ? focusKey
      : selectedKey && focusable.some((row) => row.key === selectedKey)
        ? selectedKey
        : (focusable[0]?.key ?? null);

  const focusRow = (key: string) => {
    setFocusKey(key);
    requestAnimationFrame(() => {
      rowElement(tree.current, key)?.focus();
    });
  };

  const activate = (row: Row) => {
    if (row.kind === 'action') {
      row.run();
      return;
    }
    if (row.kind === 'status') return;
    if (row.kind === 'local-dir') {
      toggleRow(row);
      return;
    }
    if (row.kind === 'remote' && row.expandable === 'directory') {
      if (query !== null) reveal(row.key, true);
      else toggleRow(row);
      if (query !== null && !directories.has(row.entry.path)) void loadDirectory(row.entry.path);
      return;
    }
    onSelect(sourceFor(row));
  };

  const onTwisty = (event: MouseEvent, row: Row) => {
    event.stopPropagation();
    setFocusKey(row.key);
    toggleRow(row);
  };

  const isOpenable = (row: Row) =>
    query === null &&
    ((row.kind === 'remote' && row.expandable !== null) ||
      row.kind === 'local-dir' ||
      (row.kind === 'local' && row.expandable !== null));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = focusable.findIndex((row) => row.key === activeKey);
    const row = focusable[index];
    const move = (to: number) => {
      const target = focusable[Math.max(0, Math.min(focusable.length - 1, to))];
      if (target) focusRow(target.key);
    };
    switch (event.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        move(index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(focusable.length - 1);
        break;
      case 'ArrowRight':
        if (row && isOpenable(row)) {
          if (!expanded.has(row.key)) toggleRow(row, true);
          else move(index + 1);
        }
        break;
      case 'ArrowLeft':
        if (row && query === null && row.kind !== 'action') {
          if (isOpenable(row) && expanded.has(row.key)) toggleRow(row, false);
          else {
            const parent = ancestorsOf(row.key).at(-1);
            if (parent) focusRow(parent);
          }
        }
        break;
      case 'Enter':
      case ' ':
        if (row) activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const text = search.trim();
    if (text === '') {
      setQuery(null);
      return;
    }
    setQuery({ text, scope });
    if (scope === 'outer') void loadResults(text);
  };
  const clearSearch = () => {
    setQuery(null);
    setSearch('');
  };

  const resultCount =
    query === null
      ? null
      : query.scope === 'outer'
        ? results && !results.loading
          ? results.total
          : null
        : (localResults?.total ?? 0);

  return (
    <div className="archive-tree-panel">
      <form className="archive-search" role="search" onSubmit={submitSearch}>
        <label htmlFor={`${ids}-search`} className="visually-hidden">
          Search paths
        </label>
        <div className="archive-search-field">
          <Search size={ICON_SIZE - 2} aria-hidden="true" className="archive-search-icon" />
          <input
            id={`${ids}-search`}
            className="form-control form-control-sm"
            type="search"
            placeholder={scope === 'outer' ? 'Search files…' : 'Search opened archives…'}
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <IconButton icon={Search} label="Search" type="submit" />
        {query !== null ? (
          <IconButton icon={X} label="Clear the search" onClick={clearSearch} />
        ) : null}
      </form>
      {loadedArchives > 0 ? (
        <div className="archive-search-scope small">
          <label htmlFor={`${ids}-scope`}>Search in</label>
          <select
            id={`${ids}-scope`}
            className="form-select form-select-sm w-auto"
            value={scope}
            onChange={(event) => setScope(event.target.value as 'outer' | 'loaded')}
          >
            <option value="outer">The version’s archive</option>
            <option value="loaded">Opened archives ({loadedArchives})</option>
          </select>
        </div>
      ) : null}
      {query !== null && resultCount !== null ? (
        <p className="small mb-1" role="status">
          {resultCount} {resultCount === 1 ? 'path matches' : 'paths match'} “{query.text}”
          {query.scope === 'loaded'
            ? ` in the ${loadedArchives === 1 ? 'archive' : `${loadedArchives} archives`} opened here. Archives not opened were not searched.`
            : '. Archives inside it are searched only once opened.'}
        </p>
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <div
        ref={tree}
        className="archive-tree"
        role="tree"
        aria-label={query === null ? 'Archive files' : 'Search results'}
        onKeyDown={onKeyDown}
      >
        {rows.map((row) => {
          const indent = { paddingInlineStart: `${(row.level - 1) * 1.1 + 0.25}rem` };
          if (row.kind === 'status') {
            return (
              <div
                key={row.key}
                className={`archive-tree-status small ${row.problem ? 'text-danger' : 'text-body-secondary'}`}
                style={indent}
                role={row.problem ? 'alert' : undefined}
              >
                {row.busy ? (
                  <LoaderCircle size={12} aria-hidden="true" className="icon-spin me-1" />
                ) : null}
                {row.text}
              </div>
            );
          }
          if (row.kind === 'action') {
            return (
              <div
                key={row.key}
                data-key={domKey(row.key)}
                role="treeitem"
                aria-level={row.level}
                aria-selected={false}
                tabIndex={row.key === activeKey ? 0 : -1}
                className="archive-tree-row archive-tree-more small"
                style={indent}
                onClick={() => activate(row)}
                onFocus={() => setFocusKey(row.key)}
              >
                {row.text}
              </div>
            );
          }
          const openable = isOpenable(row);
          const open = openable && expanded.has(row.key);
          const selected =
            row.key === selectedKey &&
            row.kind !== 'local-dir' &&
            !(row.kind === 'remote' && row.entry.type === 'directory');
          const isDirectory =
            row.kind === 'local-dir' || (row.kind === 'remote' && row.entry.type === 'directory');
          const local = row.kind === 'local' ? row.entry : null;
          const remote = row.kind === 'remote' ? row.entry : null;
          const isArchive =
            row.kind !== 'local-dir' &&
            (row.expandable === 'archive' ||
              (remote
                ? unsupportedArchiveFromName(remote.name) !== null
                : local?.unsupportedArchive != null));
          const nestedNode = nested.get(row.key);
          const description = isDirectory
            ? `${row.label}, directory`
            : row.expandable === 'archive'
              ? `${row.label}, ${FORMAT_LABEL[local?.archive?.format ?? archiveFormatFromName(row.label) ?? ''] ?? ''} archive${nestedNode?.status === 'ready' ? ', opened' : ''}`
              : local?.problem
                ? `${row.label}, cannot be read`
                : row.label;
          const iconKind = fileIconKind(row.label, {
            directory: isDirectory,
            open,
            archive: isArchive,
            link: local?.type === 'link',
          });
          const size = remote ? remote.sizeBytes : local ? local.sizeBytes : null;
          return (
            <div
              key={row.key}
              data-key={domKey(row.key)}
              role="treeitem"
              aria-level={row.level}
              aria-selected={selected}
              aria-expanded={openable ? open : undefined}
              aria-busy={nestedNode?.status === 'loading' || undefined}
              aria-label={description}
              tabIndex={row.key === activeKey ? 0 : -1}
              className={`archive-tree-row ${selected ? 'archive-tree-selected' : ''} ${local?.problem ? 'archive-tree-unreadable' : ''}`}
              style={indent}
              title={
                remote
                  ? remote.path
                  : local
                    ? local.path
                    : row.kind === 'local-dir'
                      ? row.path
                      : undefined
              }
              onClick={() => {
                setFocusKey(row.key);
                activate(row);
              }}
              onFocus={() => setFocusKey(row.key)}
            >
              {openable ? (
                <span
                  className="archive-twisty"
                  aria-hidden="true"
                  onClick={(event) => onTwisty(event, row)}
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
              ) : (
                <span className="archive-twisty" aria-hidden="true" />
              )}
              <FileTypeIcon kind={iconKind} size={15} className="archive-icon" />
              <span className="archive-tree-name text-truncate">{row.label}</span>
              {remote?.type === 'directory' && remote.childCount !== null ? (
                <span className="archive-tree-size small text-body-secondary">
                  {remote.childCount} {remote.childCount === 1 ? 'item' : 'items'}
                </span>
              ) : size !== null && !isDirectory ? (
                <span className="archive-tree-size small text-body-secondary">
                  {formatBytes(size)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
