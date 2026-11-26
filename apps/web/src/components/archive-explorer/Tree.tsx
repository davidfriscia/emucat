import type {
  ArchiveEntry,
  ArchiveListingResponse,
  ArchiveView,
  VmIdentity,
} from '@emucat/contracts';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { fetchArchiveEntries } from '../../api';
import { formatBytes } from '../Agents';
import { problemText } from './problems';

/**
 * The left panel of Archive Explorer (decision 0056): an expandable tree whose directories are listed by the server
 * one at a time, as they are opened, and in pages, so that a directory of many thousands of entries never arrives in
 * one piece. Search replaces the tree with a flat list of matching paths. Expanded directories survive selecting
 * files and switching views.
 *
 * Keyboard, as the WAI-ARIA tree pattern: Up and Down move, Right opens a directory or enters it, Left closes it or
 * goes to its parent, Home and End jump, Enter or Space selects a file or opens a directory.
 */

const PAGE_SIZE = 200;

interface DirectoryState {
  entries: ArchiveEntry[];
  total: number;
  nextOffset: number | null;
  loading: boolean;
  error: unknown;
}

type Row =
  | { kind: 'entry'; key: string; entry: ArchiveEntry; level: number; label: string }
  | { kind: 'more'; key: string; directory: string; level: number; shown: number; total: number }
  | { kind: 'status'; key: string; level: number; text: string; problem: boolean };

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function FileIcon({ entry, open }: { entry: ArchiveEntry; open: boolean }) {
  if (entry.type === 'directory') {
    return (
      <span className="archive-icon" aria-hidden="true">
        {open ? '📂' : '📁'}
      </span>
    );
  }
  return (
    <span className="archive-icon" aria-hidden="true">
      📄
    </span>
  );
}

export function ArchiveTree({
  vm,
  versionId,
  view,
  selectedPath,
  onSelect,
}: {
  vm: VmIdentity;
  versionId: string;
  view: ArchiveView;
  selectedPath: string | null;
  onSelect: (entry: ArchiveEntry) => void;
}) {
  const ids = useId();
  const { emulatorType, vmName } = vm;
  const [directories, setDirectories] = useState<Map<string, DirectoryState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [results, setResults] = useState<DirectoryState | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const tree = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active) controller.abort();
    };
  }, []);

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

  const toggle = (path: string, open?: boolean) => {
    const opening = open ?? !expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(path);
      else next.delete(path);
      return next;
    });
    if (opening && !directories.has(path)) void loadDirectory(path);
  };

  /** Opens a directory found by search in the tree, with every directory above it. */
  const reveal = (path: string) => {
    setQuery(null);
    setSearch('');
    const chain: string[] = [];
    for (let at = path; at !== ''; at = parentOf(at)) chain.unshift(at);
    setExpanded((current) => new Set([...current, ...chain]));
    for (const directory of chain) if (!directories.has(directory)) void loadDirectory(directory);
    setFocusKey(path);
  };

  const rows: Row[] = [];
  if (query === null) {
    const walk = (path: string, level: number) => {
      const state = directories.get(path);
      if (!state) return;
      for (const entry of state.entries) {
        rows.push({ kind: 'entry', key: entry.path, entry, level, label: entry.name });
        if (entry.type === 'directory' && expanded.has(entry.path)) walk(entry.path, level + 1);
      }
      if (state.loading) {
        rows.push({
          kind: 'status',
          key: `${path}\0loading`,
          level,
          text: 'Loading…',
          problem: false,
        });
      } else if (state.error) {
        rows.push({
          kind: 'status',
          key: `${path}\0error`,
          level,
          text: problemText(state.error),
          problem: true,
        });
      } else if (state.nextOffset !== null) {
        rows.push({
          kind: 'more',
          key: `${path}\0more`,
          directory: path,
          level,
          shown: state.entries.length,
          total: state.total,
        });
      } else if (state.entries.length === 0) {
        rows.push({ kind: 'status', key: `${path}\0empty`, level, text: 'Empty', problem: false });
      }
    };
    walk('', 1);
  } else if (results) {
    for (const entry of results.entries) {
      rows.push({ kind: 'entry', key: entry.path, entry, level: 1, label: entry.path });
    }
    if (results.loading)
      rows.push({ kind: 'status', key: '\0loading', level: 1, text: 'Searching…', problem: false });
    else if (results.error)
      rows.push({
        kind: 'status',
        key: '\0error',
        level: 1,
        text: problemText(results.error),
        problem: true,
      });
    else if (results.nextOffset !== null)
      rows.push({
        kind: 'more',
        key: '\0more',
        directory: '',
        level: 1,
        shown: results.entries.length,
        total: results.total,
      });
  }

  const focusable = rows.filter((row) => row.kind !== 'status');
  const activeKey =
    focusKey && focusable.some((row) => row.key === focusKey)
      ? focusKey
      : selectedPath && focusable.some((row) => row.key === selectedPath)
        ? selectedPath
        : (focusable[0]?.key ?? null);

  const focusRow = (key: string) => {
    setFocusKey(key);
    requestAnimationFrame(() => {
      const element = tree.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      element?.focus();
    });
  };

  const activate = (row: Row) => {
    if (row.kind === 'more') {
      if (query !== null) void loadResults(query, row.shown);
      else void loadDirectory(row.directory, row.shown);
      return;
    }
    if (row.kind !== 'entry') return;
    if (row.entry.type === 'directory') {
      if (query !== null) reveal(row.entry.path);
      else toggle(row.entry.path);
    } else {
      onSelect(row.entry);
    }
  };

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
        if (row?.kind === 'entry' && row.entry.type === 'directory' && query === null) {
          if (!expanded.has(row.entry.path)) toggle(row.entry.path, true);
          else move(index + 1);
        }
        break;
      case 'ArrowLeft':
        if (row?.kind === 'entry' && query === null) {
          if (row.entry.type === 'directory' && expanded.has(row.entry.path))
            toggle(row.entry.path, false);
          else {
            const parent = parentOf(row.entry.path);
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
    setQuery(text);
    void loadResults(text);
  };

  return (
    <div className="archive-tree-panel">
      <form className="d-flex gap-1 mb-2" role="search" onSubmit={submitSearch}>
        <label htmlFor={`${ids}-search`} className="visually-hidden">
          Search paths
        </label>
        <input
          id={`${ids}-search`}
          className="form-control form-control-sm"
          type="search"
          placeholder="Search all paths"
          maxLength={200}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-outline-secondary theme-button">
          Search
        </button>
        {query !== null ? (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary theme-button"
            onClick={() => {
              setQuery(null);
              setSearch('');
            }}
          >
            Clear
          </button>
        ) : null}
      </form>
      {query !== null && results && !results.loading ? (
        <p className="small mb-1" role="status">
          {results.total} {results.total === 1 ? 'path matches' : 'paths match'} “{query}”.
        </p>
      ) : null}
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
                {row.text}
              </div>
            );
          }
          if (row.kind === 'more') {
            return (
              <div
                key={row.key}
                data-key={row.key}
                role="treeitem"
                aria-level={row.level}
                aria-selected={false}
                tabIndex={row.key === activeKey ? 0 : -1}
                className="archive-tree-row archive-tree-more small"
                style={indent}
                onClick={() => activate(row)}
                onFocus={() => setFocusKey(row.key)}
              >
                Show more ({row.shown} of {row.total})
              </div>
            );
          }
          const { entry } = row;
          const open = entry.type === 'directory' && expanded.has(entry.path) && query === null;
          const selected = entry.type === 'file' && entry.path === selectedPath;
          return (
            <div
              key={row.key}
              data-key={row.key}
              role="treeitem"
              aria-level={row.level}
              aria-selected={selected}
              aria-expanded={entry.type === 'directory' && query === null ? open : undefined}
              aria-label={entry.type === 'directory' ? `${row.label}, directory` : row.label}
              tabIndex={row.key === activeKey ? 0 : -1}
              className={`archive-tree-row ${selected ? 'archive-tree-selected' : ''}`}
              style={indent}
              title={entry.path}
              onClick={() => {
                setFocusKey(row.key);
                activate(row);
              }}
              onFocus={() => setFocusKey(row.key)}
            >
              {entry.type === 'directory' && query === null ? (
                <span className="archive-twisty" aria-hidden="true">
                  {open ? '▾' : '▸'}
                </span>
              ) : (
                <span className="archive-twisty" aria-hidden="true" />
              )}
              <FileIcon entry={entry} open={open} />
              <span className="archive-tree-name text-truncate">{row.label}</span>
              {entry.type === 'file' && entry.sizeBytes !== null ? (
                <span className="archive-tree-size small text-body-secondary">
                  {formatBytes(entry.sizeBytes)}
                </span>
              ) : entry.childCount !== null ? (
                <span className="archive-tree-size small text-body-secondary">
                  {entry.childCount} {entry.childCount === 1 ? 'item' : 'items'}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
