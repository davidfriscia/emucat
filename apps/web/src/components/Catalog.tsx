import {
  EMULATOR_LABELS,
  EMULATOR_TYPES,
  isEmulatorType,
  type EmulatorType,
  type Pagination as PaginationInfo,
  type VmVisibility,
} from '@emucat/contracts';
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { BrandMark } from './Brand';

export function EmulatorBadge({ emulatorType }: { emulatorType: EmulatorType }) {
  return (
    <span className="badge text-bg-secondary emulator-badge">{EMULATOR_LABELS[emulatorType]}</span>
  );
}

export function VisibilityBadge({ visibility }: { visibility: VmVisibility }) {
  return visibility === 'public' ? (
    <span className="badge text-bg-success">Public</span>
  ) : (
    <span className="badge text-bg-dark border">Private</span>
  );
}

function VmPlaceholder({ markSize }: { markSize: number }) {
  return (
    <div className="vm-image-placeholder" role="img" aria-label="No image">
      <BrandMark size={markSize} />
    </div>
  );
}

/** A VM's image in the shared 4:3 frame, or the placeholder if there is none or it fails to load. */
export function VmImage({
  src,
  alt,
  markSize = 56,
}: {
  src: string | null;
  alt: string;
  markSize?: number;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) return <VmPlaceholder markSize={markSize} />;
  return (
    <img
      className="vm-image"
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailedSrc(src)}
    />
  );
}

export function VmCard({
  to,
  title,
  emulatorType,
  summary,
  imageSrc,
  badges,
}: {
  to: string;
  title: string;
  emulatorType: EmulatorType;
  summary: string | null;
  imageSrc: string | null;
  badges?: ReactNode;
}) {
  return (
    <article className="card vm-card h-100 position-relative">
      <VmImage src={imageSrc} alt="" />
      <div className="card-body">
        <h2 className="h6 card-title vm-card-title mb-2">
          <Link to={to}>{title}</Link>
        </h2>
        <div className="d-flex flex-wrap gap-1 mb-2">
          <EmulatorBadge emulatorType={emulatorType} />
          {badges}
        </div>
        {summary ? (
          <p className="small text-body-secondary mb-0 vm-card-summary">{summary}</p>
        ) : null}
      </div>
    </article>
  );
}

function positiveInteger(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1_000_000 ? parsed : 1;
}

const VM_VISIBILITIES: readonly VmVisibility[] = ['public', 'private'];

/** Filters live in the URL, so that a filtered catalog can be linked, reloaded and navigated back to. */
export function useCatalogFilters() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const emulatorParameter = params.get('emulator');
  const emulatorType = isEmulatorType(emulatorParameter) ? emulatorParameter : undefined;
  const visibility = VM_VISIBILITIES.find((value) => value === params.get('visibility'));
  const page = positiveInteger(params.get('page'));

  /** Changing any filter goes back to the first page. */
  const update = useCallback(
    (changes: Record<string, string | undefined>) => {
      setParams((previous) => {
        const next = new URLSearchParams(previous);
        if (!('page' in changes)) next.delete('page');
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      });
    },
    [setParams],
  );

  return {
    q,
    emulatorType,
    visibility,
    page,
    update,
    filtered: Boolean(q || emulatorType || visibility),
  };
}

export type CatalogFiltersState = ReturnType<typeof useCatalogFilters>;

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(text.trim());
  };
  return (
    <form role="search" onSubmit={submit} className="input-group catalog-search">
      <input
        type="search"
        className="form-control"
        placeholder="Search by name or description"
        aria-label="Search virtual machines"
        maxLength={100}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="btn btn-outline-primary">
        Search
      </button>
    </form>
  );
}

export function CatalogControls({
  filters,
  showVisibility = false,
}: {
  filters: CatalogFiltersState;
  showVisibility?: boolean;
}) {
  const options: { value: EmulatorType | undefined; label: string }[] = [
    { value: undefined, label: 'All' },
    ...EMULATOR_TYPES.map((value) => ({ value, label: EMULATOR_LABELS[value] })),
  ];
  return (
    <div className="row g-2 align-items-center mb-3">
      <div className="col-12 col-md">
        {/* Remounted when the URL changes, so that Back also restores the text in the box. */}
        <SearchBox
          key={filters.q}
          initial={filters.q}
          onSearch={(text) => filters.update({ q: text })}
        />
      </div>
      <div className="col-auto">
        <div className="nav nav-pills" role="group" aria-label="Filter by emulator">
          {options.map(({ value, label }) => (
            <button
              key={label}
              type="button"
              className={`nav-link py-1 px-3${filters.emulatorType === value ? ' active' : ''}`}
              aria-pressed={filters.emulatorType === value}
              onClick={() => filters.update({ emulator: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {showVisibility ? (
        <div className="col-auto">
          <select
            className="form-select form-select-sm"
            aria-label="Filter by visibility"
            value={filters.visibility ?? ''}
            onChange={(event) => filters.update({ visibility: event.target.value })}
          >
            <option value="">Any visibility</option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </div>
      ) : null}
    </div>
  );
}

/** Page numbers to show: the first, the last, and those around the current page. */
function visiblePages(page: number, totalPages: number): (number | 'gap')[] {
  const pages: (number | 'gap')[] = [];
  for (let candidate = 1; candidate <= totalPages; candidate += 1) {
    if (candidate === 1 || candidate === totalPages || Math.abs(candidate - page) <= 1) {
      const previous = pages.at(-1);
      if (typeof previous === 'number' && candidate - previous > 1) pages.push('gap');
      pages.push(candidate);
    }
  }
  return pages;
}

export function Pagination({
  pagination,
  onPage,
}: {
  pagination: PaginationInfo;
  onPage: (page: number) => void;
}) {
  const { page, totalPages, total } = pagination;
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Catalog pages" className="mt-4">
      <p className="small text-body-secondary text-center mb-2">
        {total} virtual machines, page {page} of {totalPages}
      </p>
      <ul className="pagination pagination-sm justify-content-center flex-wrap mb-0">
        <li className={`page-item${page <= 1 ? ' disabled' : ''}`}>
          <button
            type="button"
            className="page-link"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            Previous
          </button>
        </li>
        {visiblePages(page, totalPages).map((item, index) =>
          item === 'gap' ? (
            <li className="page-item disabled" key={`gap-${index}`}>
              <span className="page-link">…</span>
            </li>
          ) : (
            <li className={`page-item${item === page ? ' active' : ''}`} key={item}>
              <button
                type="button"
                className="page-link"
                aria-current={item === page ? 'page' : undefined}
                onClick={() => onPage(item)}
              >
                {item}
              </button>
            </li>
          ),
        )}
        <li className={`page-item${page >= totalPages ? ' disabled' : ''}`}>
          <button
            type="button"
            className="page-link"
            disabled={page >= totalPages}
            onClick={() => onPage(page + 1)}
          >
            Next
          </button>
        </li>
      </ul>
    </nav>
  );
}

/** An explanation of why there is no way to add a VM here, used on the administration pages. */
export function RegistrationNote() {
  return (
    <div className="alert alert-secondary small" role="note">
      <strong>Adding virtual machines.</strong> A VM joins the catalog when a connected EmuCat agent
      discovers it on your computer and you confirm its registration. That arrives in a later
      milestone, along with agent pairing. Until then, this page manages VMs that are already
      registered.
    </div>
  );
}
