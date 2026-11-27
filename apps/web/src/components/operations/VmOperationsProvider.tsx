import {
  isVmOperationActive,
  vmOperationSourceVersionId,
  type RegistrationOperation,
  type VmIdentity,
  type VmOperation,
  type VmOperationListResponse,
  type VmOperationRelation,
} from '@emucat/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fetchVmOperations } from '../../api';
import { usePolledData } from '../../usePolledData';
import { operationOutcomeText } from './text';

/**
 * The operations of one VM's versions, followed once for every section of its management (decision 0060). The
 * Version History and General pages read the same list through {@link useVmOperations}, so that they always agree
 * and there is one request loop per VM, not one per component.
 *
 * The list is what the server persisted (`GET …/operations`): it survives navigation, a refresh, closing the
 * browser and a restart of the API. Nothing here is inferred from a click, a timer or the length of a request.
 */

/** While anything runs: often enough to follow a phase, rarely enough that a long transfer costs little. */
export const OPERATIONS_ACTIVE_POLL_MS = 2_000;
/** Otherwise: an operation started elsewhere (another tab, a Remote Snapshot ending) still appears. */
export const OPERATIONS_IDLE_POLL_MS = 15_000;
/** How long a success stays shown, unless dismissed sooner. Failures stay until dismissed or the server drops them. */
export const SUCCESS_DISPLAY_MS = 30 * 60 * 1000;

const DISMISSED_KEY = 'emucat.operations.dismissed';
const DISMISSED_MAX = 200;

export interface VmOperationsValue {
  vm: VmIdentity;
  /** Everything listed: active first. Empty until the first answer. */
  entries: VmOperation[];
  /** What is shown: every active operation, and ended ones not dismissed and still within their display period. */
  visible: VmOperation[];
  /** Whether a first answer arrived. */
  loaded: boolean;
  /** Whether the latest request failed: `entries` is then the last known state, and may be out of date. */
  unavailable: boolean;
  /** When the shown state was received, by the browser's clock. `null` before the first answer. */
  receivedAt: number | null;
  /** The server's clock minus the browser's, to measure elapsed time against the server. */
  clockOffsetMs: number;
  /** The server's time at its latest answer: what elapsed times and the display period are measured against. */
  serverNow: number | null;
  /** Requests the list again now. */
  refresh: () => void;
  /**
   * Shows an operation the API just accepted, until the list includes it. The 202 answer is the server's own record,
   * so this is authoritative, not optimistic.
   */
  track: (operation: RegistrationOperation, relation: VmOperationRelation) => void;
  /** Counts the operations seen to end, so that a page can read what they changed (a new version, a count). */
  revision: number;
  /** Hides an ended operation's notice here. The server's record is not touched. */
  dismiss: (operationId: string) => void;
  /** The shown operations drawn on one version. */
  forVersion: (versionId: string) => VmOperation[];
}

const Context = createContext<VmOperationsValue | null>(null);

/** The VM's operations, or `null` outside a provider. */
export function useVmOperations(): VmOperationsValue | null {
  return useContext(Context);
}

function readDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-DISMISSED_MAX)));
  } catch {
    // A private window or blocked storage: dismissing still works until the page is reloaded.
  }
}

interface Listing extends VmOperationListResponse {
  /** When the request that produced this answer started, by the browser's clock. */
  requestedAt: number;
  receivedAt: number;
}

interface Tracked {
  entry: VmOperation;
  trackedAt: number;
}

/** Whether an ended operation is still shown, by the display policy. */
function shownWhenEnded(entry: VmOperation, now: number, dismissed: ReadonlySet<string>): boolean {
  const { operation } = entry;
  if (dismissed.has(operation.id)) return false;
  if (operation.state !== 'succeeded') return true;
  const finished = operation.finishedAt ? Date.parse(operation.finishedAt) : now;
  return now - finished < SUCCESS_DISPLAY_MS;
}

export function VmOperationsProvider({
  vm,
  onEnded,
  children,
}: {
  vm: VmIdentity;
  /** Called once each time operations are seen to end, after the first answer. */
  onEnded?: (ended: VmOperation[]) => void;
  children: ReactNode;
}) {
  const { emulatorType, vmName } = vm;
  const load = useCallback(
    async (signal: AbortSignal): Promise<Listing> => {
      const requestedAt = Date.now();
      const listing = await fetchVmOperations({ emulatorType, vmName }, signal);
      return { ...listing, requestedAt, receivedAt: Date.now() };
    },
    [emulatorType, vmName],
  );
  const [active, setActive] = useState(false);
  const polled = usePolledData(load, active ? OPERATIONS_ACTIVE_POLL_MS : OPERATIONS_IDLE_POLL_MS);
  const listing = polled.data;
  const [tracked, setTracked] = useState<Tracked[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set(readDismissed()));
  const [revision, setRevision] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const seen = useRef<Map<string, boolean> | null>(null);
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  });

  // A tracked operation is dropped once a listing requested after it includes it, or does not: the listing is then
  // the authority either way.
  const pending = useMemo(
    () =>
      listing
        ? tracked.filter(
            (item) =>
              item.trackedAt >= listing.requestedAt &&
              !listing.operations.some((entry) => entry.operation.id === item.entry.operation.id),
          )
        : tracked,
    [listing, tracked],
  );
  if (pending.length !== tracked.length) setTracked(pending);

  const entries = useMemo(() => {
    const listed = listing?.operations ?? [];
    const extra = pending
      .map((item) => item.entry)
      .filter((entry) => !listed.some((other) => other.operation.id === entry.operation.id));
    return [...extra, ...listed];
  }, [listing, pending]);

  const anyActive = entries.some((entry) => isVmOperationActive(entry.operation));
  if (anyActive !== active) setActive(anyActive);

  // What ended since the previous answer: announced once, and given to the page to read what changed.
  useEffect(() => {
    if (!listing) return;
    const states = new Map(
      listing.operations.map((entry) => [entry.operation.id, isVmOperationActive(entry.operation)]),
    );
    const previous = seen.current;
    seen.current = states;
    if (previous === null) return;
    const ended = listing.operations.filter(
      (entry) =>
        !isVmOperationActive(entry.operation) &&
        // Seen running before, or started and ended between two answers.
        (previous.get(entry.operation.id) === true || !previous.has(entry.operation.id)),
    );
    if (ended.length === 0) return;
    setRevision((value) => value + 1);
    setAnnouncement(ended.map((entry) => operationOutcomeText(entry)).join('. '));
    onEndedRef.current?.(ended);
  }, [listing]);

  const refresh = polled.refresh;
  const track = useCallback(
    (operation: RegistrationOperation, relation: VmOperationRelation) => {
      setTracked((current) => [
        ...current.filter((item) => item.entry.operation.id !== operation.id),
        {
          entry: {
            relation,
            operation,
            transport: operation.performedBy === 'server' ? 'server' : null,
          },
          trackedAt: Date.now(),
        },
      ]);
      refresh();
    },
    [refresh],
  );
  const dismiss = useCallback((operationId: string) => {
    setDismissed((current) => {
      const next = new Set(current);
      next.add(operationId);
      writeDismissed([...next]);
      return next;
    });
  }, []);

  const receivedAt = listing?.receivedAt ?? null;
  const clockOffsetMs = listing ? Date.parse(listing.serverTime) - listing.receivedAt : 0;
  const serverNow = listing ? Date.parse(listing.serverTime) : null;
  const value = useMemo<VmOperationsValue>(() => {
    const visible = entries.filter(
      (entry) =>
        isVmOperationActive(entry.operation) ||
        // Before any answer only tracked operations are known, and they are all shown.
        serverNow === null ||
        shownWhenEnded(entry, serverNow, dismissed),
    );
    return {
      vm: { emulatorType, vmName },
      entries,
      visible,
      loaded: listing !== null,
      unavailable: polled.error !== null,
      receivedAt,
      clockOffsetMs,
      serverNow,
      refresh,
      track,
      revision,
      dismiss,
      forVersion: (versionId) =>
        visible.filter((entry) => vmOperationSourceVersionId(entry) === versionId),
    };
  }, [
    emulatorType,
    vmName,
    entries,
    dismissed,
    listing,
    polled.error,
    receivedAt,
    clockOffsetMs,
    serverNow,
    refresh,
    track,
    revision,
    dismiss,
  ]);

  return (
    <Context.Provider value={value}>
      {children}
      {/* The one announcement of operations ending, for every section: never each progress update. */}
      <div
        className="visually-hidden operation-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
    </Context.Provider>
  );
}

/** A provider, unless one is already there: the version history can be shown outside the VM's management too. */
export function WithVmOperations({ vm, children }: { vm: VmIdentity; children: ReactNode }) {
  const existing = useVmOperations();
  if (
    existing &&
    existing.vm.emulatorType === vm.emulatorType &&
    existing.vm.vmName === vm.vmName
  ) {
    return <>{children}</>;
  }
  return <VmOperationsProvider vm={vm}>{children}</VmOperationsProvider>;
}
