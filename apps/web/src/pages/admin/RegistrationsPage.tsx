import {
  EMULATOR_TYPES,
  isEmulatorType,
  REGISTRATION_MODES,
  type EmulatorType,
  type RegistrationMode,
  type RegistrationState,
} from '@emucat/contracts';
import { useCallback, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { fetchAgents, fetchRegistrations, type RegistrationListFilters } from '../../api';
import { REGISTRATION_MODE_TEXT, RegistrationHistoryTable } from '../../components/Registration';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { useAsync } from '../../useAsync';

const PAGE_SIZE = 25;
const EMULATOR_NAMES: Record<EmulatorType, string> = { '86box': '86Box', qemu: 'QEMU' };

const RUNNING_STATES: readonly RegistrationState[] = [
  'queued',
  'validating',
  'archiving',
  'uploading',
  'verifying',
  'committing',
  'cleaning_local',
];

/** One choice of what to see, as the status filter offers it. `attention` is a view of its own. */
const STATUS_FILTERS = {
  attention: { label: 'Needs attention', view: 'attention' as const },
  running: { label: 'Running', states: RUNNING_STATES },
  succeeded: { label: 'Registered or created', states: ['succeeded'] },
  partial_success: { label: 'Registered, with a problem', states: ['partial_success'] },
  failed: { label: 'Failed', states: ['failed'] },
  cancelled: { label: 'Cancelled', states: ['cancelled'] },
} satisfies Record<
  string,
  { label: string; view?: 'attention'; states?: readonly RegistrationState[] }
>;
type StatusFilter = keyof typeof STATUS_FILTERS;

const isStatusFilter = (value: string | null): value is StatusFilter =>
  value !== null && Object.hasOwn(STATUS_FILTERS, value);
const isMode = (value: string | null): value is RegistrationMode =>
  (REGISTRATION_MODES as readonly (string | null)[]).includes(value);
const isDate = (value: string | null): value is string =>
  value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The start of a local calendar day, as an instant. */
function startOfDay(date: string, plusDays = 0): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day + plusDays).toISOString();
}

/** The filters live in the URL, so a filtered history can be linked to, and Back restores it. */
function useRegistrationFilters() {
  const [params, setParams] = useSearchParams();
  const agentParameter = params.get('agentId');
  const statusParameter = params.get('status');
  const modeParameter = params.get('mode');
  const emulatorParameter = params.get('emulator');
  const from = params.get('from');
  const to = params.get('to');
  const filters = {
    agentId: agentParameter && UUID.test(agentParameter) ? agentParameter : undefined,
    status: isStatusFilter(statusParameter) ? statusParameter : undefined,
    mode: isMode(modeParameter) ? modeParameter : undefined,
    emulatorType: isEmulatorType(emulatorParameter) ? emulatorParameter : undefined,
    q: params.get('q')?.trim() || undefined,
    from: isDate(from) ? from : undefined,
    to: isDate(to) ? to : undefined,
  };
  const update = useCallback(
    (changes: Record<string, string | undefined>) => {
      setParams((previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      });
    },
    [setParams],
  );
  const filtered = Object.values(filters).some((value) => value !== undefined);
  return { filters, update, filtered };
}

type Filters = ReturnType<typeof useRegistrationFilters>['filters'];

function toQuery(filters: Filters, cursor: string | undefined): RegistrationListFilters {
  const status = filters.status ? STATUS_FILTERS[filters.status] : undefined;
  return {
    view: status && 'view' in status ? status.view : 'all',
    states: status && 'states' in status ? status.states : undefined,
    agentId: filters.agentId,
    emulatorType: filters.emulatorType,
    mode: filters.mode,
    q: filters.q,
    createdFrom: filters.from ? startOfDay(filters.from) : undefined,
    createdBefore: filters.to ? startOfDay(filters.to, 1) : undefined,
    cursor,
    limit: PAGE_SIZE,
  };
}

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(text.trim());
  };
  return (
    <form role="search" onSubmit={submit} className="input-group input-group-sm">
      <input
        type="search"
        className="form-control"
        aria-label="Search by VM name"
        placeholder="VM name"
        maxLength={64}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="btn btn-outline-secondary theme-button">
        Search
      </button>
    </form>
  );
}

function FilterControls({
  filters,
  update,
}: {
  filters: Filters;
  update: (changes: Record<string, string | undefined>) => void;
}) {
  const loadAgents = useCallback((signal: AbortSignal) => fetchAgents(signal), []);
  const { state: agents } = useAsync(loadAgents);
  const agentList = agents.status === 'success' ? agents.data.agents : [];
  return (
    <div className="row g-2 align-items-end mb-3">
      <div className="col-12 col-md-4">
        <SearchBox
          key={filters.q ?? ''}
          initial={filters.q ?? ''}
          onSearch={(q) => update({ q })}
        />
      </div>
      <div className="col-6 col-md-auto">
        <select
          className="form-select form-select-sm"
          aria-label="Filter by agent"
          value={filters.agentId ?? ''}
          onChange={(event) => update({ agentId: event.target.value })}
        >
          <option value="">Every agent</option>
          {agentList.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
          {filters.agentId && !agentList.some((agent) => agent.id === filters.agentId) ? (
            <option value={filters.agentId}>This agent</option>
          ) : null}
        </select>
      </div>
      <div className="col-6 col-md-auto">
        <select
          className="form-select form-select-sm"
          aria-label="Filter by status"
          value={filters.status ?? ''}
          onChange={(event) => update({ status: event.target.value })}
        >
          <option value="">Any status</option>
          {Object.entries(STATUS_FILTERS).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="col-6 col-md-auto">
        <select
          className="form-select form-select-sm"
          aria-label="Filter by mode"
          value={filters.mode ?? ''}
          onChange={(event) => update({ mode: event.target.value })}
        >
          <option value="">Any mode</option>
          {REGISTRATION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {REGISTRATION_MODE_TEXT[mode]}
            </option>
          ))}
        </select>
      </div>
      <div className="col-6 col-md-auto">
        <select
          className="form-select form-select-sm"
          aria-label="Filter by emulator"
          value={filters.emulatorType ?? ''}
          onChange={(event) => update({ emulator: event.target.value })}
        >
          <option value="">Any emulator</option>
          {EMULATOR_TYPES.map((type) => (
            <option key={type} value={type}>
              {EMULATOR_NAMES[type]}
            </option>
          ))}
        </select>
      </div>
      <div className="col-6 col-md-auto">
        <label className="form-label small mb-0" htmlFor="registrations-from">
          From
        </label>
        <input
          id="registrations-from"
          type="date"
          className="form-control form-control-sm"
          value={filters.from ?? ''}
          max={filters.to}
          onChange={(event) => update({ from: event.target.value })}
        />
      </div>
      <div className="col-6 col-md-auto">
        <label className="form-label small mb-0" htmlFor="registrations-to">
          To
        </label>
        <input
          id="registrations-to"
          type="date"
          className="form-control form-control-sm"
          value={filters.to ?? ''}
          min={filters.from}
          onChange={(event) => update({ to: event.target.value })}
        />
      </div>
    </div>
  );
}

/**
 * One page at a time, from the server. Older pages follow the cursor it gave; newer ones go back along
 * the cursors already followed, so the browser never holds more than one page of history.
 */
function Results({
  filters,
  filtered,
  onClear,
}: {
  filters: Filters;
  filtered: boolean;
  onClear: () => void;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const load = useCallback(
    (signal: AbortSignal) => fetchRegistrations(toQuery(filters, cursor), signal),
    [filters, cursor],
  );
  const { state, reload } = useAsync(load);

  if (state.status === 'loading') return <LoadingState label="Loading the registrations" />;
  if (state.status === 'error') {
    return (
      <ErrorState
        title="The registrations could not be loaded"
        error={state.error}
        onRetry={reload}
      />
    );
  }
  const { operations, nextCursor, total } = state.data;
  if (operations.length === 0 && cursors.length === 0) {
    return filtered ? (
      <EmptyState
        title="Nothing matches"
        action={
          <button type="button" className="btn btn-outline-primary" onClick={onClear}>
            Clear filters
          </button>
        }
      >
        No registration matches these filters.
      </EmptyState>
    ) : (
      <EmptyState title="No registrations yet">
        To register a VM, run discovery on an agent from the Agents page, and choose Copy or
        Transfer.
      </EmptyState>
    );
  }
  return (
    <>
      {total !== undefined ? (
        <p className="small text-body-secondary">
          {total === 1
            ? '1 registration needs attention.'
            : `${total} registrations need attention.`}
        </p>
      ) : null}
      <RegistrationHistoryTable
        operations={operations}
        showAgent
        caption="Registrations, newest first"
        onChanged={reload}
      />
      <nav aria-label="Registration pages" className="mt-3">
        <p className="small text-body-secondary text-center mb-2">Page {cursors.length + 1}</p>
        <ul className="pagination pagination-sm justify-content-center mb-0">
          <li className={`page-item${cursors.length === 0 ? ' disabled' : ''}`}>
            <button
              type="button"
              className="page-link"
              disabled={cursors.length === 0}
              onClick={() => setCursors((previous) => previous.slice(0, -1))}
            >
              Newer
            </button>
          </li>
          <li className={`page-item${nextCursor ? '' : ' disabled'}`}>
            <button
              type="button"
              className="page-link"
              disabled={!nextCursor}
              onClick={() => nextCursor && setCursors((previous) => [...previous, nextCursor])}
            >
              Older
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}

/** Every registration and snapshot operation, kept for good, and read one page at a time. */
export function RegistrationsPage() {
  const { filters, update, filtered } = useRegistrationFilters();
  const key = JSON.stringify(filters);
  // Stable for as long as the filters are, so that the page is only fetched again when they change.
  const [memo, setMemo] = useState({ key, filters });
  if (memo.key !== key) setMemo({ key, filters });
  return (
    <>
      <title>Registrations · EmuCat</title>
      {filters.agentId ? (
        <p className="mb-2">
          <Link to={`/admin/agents/${filters.agentId}`}>Back to the agent</Link>
        </p>
      ) : null}
      <h1 className="h3 mb-2">Registrations</h1>
      <p className="text-body-secondary">
        Every registration of a VM and every snapshot, newest first. Nothing here is ever deleted:
        failed attempts stay, with what went wrong, for troubleshooting.
      </p>
      <FilterControls filters={filters} update={update} />
      <Results
        key={key}
        filters={memo.filters}
        filtered={filtered}
        onClear={() =>
          update({
            agentId: undefined,
            status: undefined,
            mode: undefined,
            emulator: undefined,
            q: undefined,
            from: undefined,
            to: undefined,
          })
        }
      />
    </>
  );
}
