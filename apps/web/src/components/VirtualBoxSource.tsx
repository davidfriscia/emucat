import {
  defaultVirtualBoxTargetName,
  isVirtualBoxOperationActive,
  validateVirtualBoxTargetName,
  VIRTUALBOX_TARGET_NAME_MAX_LENGTH,
  type DiscoveryOperation,
  type VirtualBoxAgentOption,
  type VirtualBoxManagementResponse,
  type VirtualBoxMachine,
  type VirtualBoxOperation,
  type VirtualBoxOperationKind,
  type VirtualBoxOperationStage,
  type VirtualBoxTargetNameError,
  type VirtualBoxVm,
  type VmIdentity,
} from '@emucat/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  deleteFromVirtualBox,
  fetchDiscovery,
  fetchVirtualBoxManagement,
  importIntoVirtualBox,
  linkVirtualBoxMachine,
  retryVirtualBoxImportLink,
  unlinkVirtualBoxMachine,
} from '../api';
import { usePolledData, type PolledData } from '../usePolledData';
import { formatTime } from './Agents';
import { ConfirmDialog } from './Dialogs';
import { useModalDialog } from './Gallery';
import { FormError } from './States';
import { STATE_BADGE, STATE_TEXT } from './VirtualBox';

/**
 * A VirtualBox VM's machine (decision 0046): which machine the catalog entry is linked to, and the imports,
 * deletions and link changes made for it. The catalog entry owns the versions and the screenshots; a machine is
 * only where it runs now, so linking, relinking and unlinking never change a version, and deleting a machine from
 * VirtualBox never deletes a version or a screenshot.
 */

const CHANGED = 'emucat:virtualbox-changed';
/** While an import or a deletion is under way. */
export const VIRTUALBOX_ACTIVE_POLL_MS = 2_000;
/** Otherwise: the link changes only through this page, which says so at once. */
export const VIRTUALBOX_IDLE_POLL_MS = 30_000;

/** Tells every part of the page about this VM's machine that something changed. */
export function notifyVirtualBoxChanged(vm: VmIdentity) {
  window.dispatchEvent(new CustomEvent<VmIdentity>(CHANGED, { detail: vm }));
}

/** Calls `onChange` whenever something on the page says this VM's machine changed. */
export function useVirtualBoxChanged(vm: VmIdentity, onChange: () => void) {
  const { emulatorType, vmName } = vm;
  useEffect(() => {
    const listener = (event: Event) => {
      const changed = (event as CustomEvent<VmIdentity>).detail;
      if (changed.emulatorType === emulatorType && changed.vmName === vmName) onChange();
    };
    window.addEventListener(CHANGED, listener);
    return () => window.removeEventListener(CHANGED, listener);
  }, [emulatorType, vmName, onChange]);
}

type Management = PolledData<VirtualBoxManagementResponse>;
const ManagementContext = createContext<{ vm: VmIdentity; management: Management } | null>(null);

/**
 * This VM's machine, its agents and its operations, polled faster while one runs. When an import or a deletion
 * finishes, the rest of the page hears of it, since it may have linked, relinked or unlinked the machine.
 */
function usePolledManagement(vm: VmIdentity): Management {
  const { emulatorType, vmName } = vm;
  const load = useCallback(
    (signal: AbortSignal) => fetchVirtualBoxManagement({ emulatorType, vmName }, signal),
    [emulatorType, vmName],
  );
  const [fast, setFast] = useState(false);
  const polled = usePolledData(load, fast ? VIRTUALBOX_ACTIVE_POLL_MS : VIRTUALBOX_IDLE_POLL_MS);
  const active =
    polled.data?.operations.some((operation) => isVirtualBoxOperationActive(operation.state)) ??
    false;
  if (active !== fast) setFast(active);
  const { refresh } = polled;
  useVirtualBoxChanged(vm, refresh);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) notifyVirtualBoxChanged({ emulatorType, vmName });
    wasActive.current = active;
  }, [active, emulatorType, vmName]);
  return polled;
}

/** One poll of this VM's machine for everything inside it, however many parts of the page show it. */
export function VirtualBoxManagementProvider({
  vm,
  children,
}: {
  vm: VmIdentity;
  children: ReactNode;
}) {
  const management = usePolledManagement(vm);
  const { emulatorType, vmName } = vm;
  const value = useMemo(
    () => ({ vm: { emulatorType, vmName }, management }),
    [emulatorType, vmName, management],
  );
  return <ManagementContext.Provider value={value}>{children}</ManagementContext.Provider>;
}

/** The machine of `vm` from the nearest provider for it, or `null` outside one. */
function useSharedManagement(vm: VmIdentity): Management | null {
  const shared = useContext(ManagementContext);
  return shared?.vm.emulatorType === vm.emulatorType && shared.vm.vmName === vm.vmName
    ? shared.management
    : null;
}

/**
 * Renders `children` with this VM's machine: the provider's, or a poll of its own outside one, so that a part of
 * the page shown alone still works.
 */
export function WithVirtualBoxManagement({
  vm,
  children,
}: {
  vm: VmIdentity;
  children: (management: Management) => ReactNode;
}) {
  const shared = useSharedManagement(vm);
  if (shared) return <>{children(shared)}</>;
  return (
    <VirtualBoxManagementProvider vm={vm}>
      <WithVirtualBoxManagement vm={vm}>{children}</WithVirtualBoxManagement>
    </VirtualBoxManagementProvider>
  );
}

const KIND_TEXT: Record<VirtualBoxOperationKind, string> = {
  import: 'Import',
  delete: 'Deletion',
  link: 'Link',
  relink: 'Link changed',
  unlink: 'Unlink',
};

const STAGE_TEXT: Record<VirtualBoxOperationStage, string> = {
  checking: 'Checking',
  downloading: 'Downloading the OVA',
  verifying: 'Verifying the OVA',
  dry_run: 'Checking the OVA with VirtualBox',
  importing: 'Importing into VirtualBox',
  discovering: 'Finding the new machine',
  deleting: 'Deleting from VirtualBox',
};

const STATE_CLASS: Record<VirtualBoxOperation['state'], string> = {
  queued: 'text-bg-secondary',
  running: 'text-bg-primary',
  succeeded: 'text-bg-success',
  failed: 'text-bg-danger',
  uncertain: 'text-bg-warning',
};

const STATE_LABEL: Record<VirtualBoxOperation['state'], string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  uncertain: 'Uncertain',
};

const TARGET_NAME_TEXT: Record<VirtualBoxTargetNameError, string> = {
  empty: 'Choose a name.',
  too_long: `Use at most ${VIRTUALBOX_TARGET_NAME_MAX_LENGTH} characters.`,
  invalid_characters: 'Do not use \\ / : * ? " < > | or control characters.',
  invalid_boundary: 'Do not start with a hyphen, or start or end with a space, or end with a dot.',
};

function bytes(value: number | null): string {
  if (value === null) return '?';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function MachineState({ state }: { state: VirtualBoxMachine['state'] | null }) {
  if (!state) return <span className="badge text-bg-dark border">Not observed yet</span>;
  return <span className={`badge ${STATE_BADGE[state]}`}>{STATE_TEXT[state]}</span>;
}

/** What an administrator may still do with a machine an import created, if anything. */
function importedMachine(
  operation: VirtualBoxOperation,
  data: VirtualBoxManagementResponse,
): { uuid: string; name: string } | null {
  if (operation.kind !== 'import' || operation.state !== 'succeeded') return null;
  if (!operation.machineUuid || operation.machineName === null) return null;
  // Deleted since: a later, successful deletion of the same machine.
  const deleted = data.operations.some(
    (other) =>
      other.kind === 'delete' &&
      other.state === 'succeeded' &&
      other.machineUuid === operation.machineUuid,
  );
  return deleted ? null : { uuid: operation.machineUuid, name: operation.machineName };
}

/** What an import does, did or could not do with its machine's link. */
function AutoLinkStatus({
  operation,
  linked,
  busy,
  onRetry,
}: {
  operation: VirtualBoxOperation;
  linked: boolean;
  busy: boolean;
  onRetry: (operation: VirtualBoxOperation) => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const autoLink = operation.autoLink;
  if (!autoLink) return null;
  const replaces = operation.previousMachineUuid;
  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      await onRetry(operation);
    } catch (failure) {
      setError(failure);
    } finally {
      setRetrying(false);
    }
  };
  if (isVirtualBoxOperationActive(operation.state)) {
    return (
      <div className="text-body-secondary">
        {autoLink.intent === 'relink' && replaces ? (
          <>
            Once imported, the new machine replaces the link to{' '}
            <code className="vm-identity small">{replaces}</code>, which stays in VirtualBox.
          </>
        ) : (
          'Once imported, the new machine is linked to this VM.'
        )}
      </div>
    );
  }
  if (autoLink.state === 'linked') {
    return (
      <div>
        <span className="badge text-bg-success">Linked automatically</span>
        {autoLink.intent === 'relink' && replaces ? (
          <span className="text-body-secondary">
            {' '}
            in place of <code className="vm-identity small">{replaces}</code>, kept in VirtualBox
          </span>
        ) : null}
      </div>
    );
  }
  if (autoLink.state === 'pending') {
    return (
      <div role="status" className="text-body-secondary">
        Imported; linking the new machine…
      </div>
    );
  }
  if (autoLink.state !== 'failed' || linked) return null;
  return (
    <div className="alert alert-warning small mt-1 mb-1" role="alert">
      <strong>Imported, but not linked.</strong> The import succeeded and the new machine stays in
      VirtualBox; only linking it failed
      {autoLink.error ? (
        <>
          : <span className="vm-identity">{autoLink.error.code}</span>, {autoLink.error.message}
        </>
      ) : (
        '.'
      )}{' '}
      Retrying links the machine already imported; it does not import again.
      <div className="mt-1">
        <button
          type="button"
          className="btn btn-sm btn-outline-primary"
          disabled={busy || retrying}
          onClick={() => void retry()}
        >
          {retrying ? 'Linking…' : 'Retry linking'}
        </button>
      </div>
      <FormError error={error} />
    </div>
  );
}

function OperationItem({
  operation,
  data,
  busy,
  onLink,
  onRetryLink,
  onDelete,
}: {
  operation: VirtualBoxOperation;
  data: VirtualBoxManagementResponse;
  busy: boolean;
  onLink: (operation: VirtualBoxOperation) => void;
  onRetryLink: (operation: VirtualBoxOperation) => Promise<void>;
  onDelete: (machine: { agentId: string; uuid: string; name: string }) => void;
}) {
  const machine = importedMachine(operation, data);
  const linked = data.source?.machineUuid === operation.machineUuid;
  const active = isVirtualBoxOperationActive(operation.state);
  return (
    <li className="card mb-2">
      <div className="card-body py-2 small">
        <div className="d-flex flex-wrap align-items-center gap-2">
          <strong>{KIND_TEXT[operation.kind]}</strong>
          <span className={`badge ${STATE_CLASS[operation.state]}`}>
            {STATE_LABEL[operation.state]}
          </span>
          <span className="text-body-secondary">
            {formatTime(operation.createdAt)} on {operation.agentName}
            {operation.requestedByDisplayName ? `, by ${operation.requestedByDisplayName}` : ''}
          </span>
        </div>
        {operation.kind === 'import' && operation.targetName ? (
          <div>
            As <span className="virtualbox-name">{operation.targetName}</span>
          </div>
        ) : null}
        {operation.machineUuid ? (
          <div>
            Machine{' '}
            {operation.machineName ? (
              <span className="virtualbox-name">{operation.machineName}</span>
            ) : null}{' '}
            <code className="vm-identity small">{operation.machineUuid}</code>
            {linked ? <span className="badge text-bg-info ms-1">Linked</span> : null}
          </div>
        ) : null}
        {operation.previousMachineUuid && operation.kind !== 'import' ? (
          <div className="text-body-secondary">
            Previously linked:{' '}
            <code className="vm-identity small">{operation.previousMachineUuid}</code>
          </div>
        ) : null}
        {operation.kind === 'import' ? (
          <AutoLinkStatus operation={operation} linked={linked} busy={busy} onRetry={onRetryLink} />
        ) : null}
        {active && operation.stage ? (
          <div role="status">
            {STAGE_TEXT[operation.stage]}
            {operation.progress.totalBytes
              ? ` (${bytes(operation.progress.doneBytes)} of ${bytes(operation.progress.totalBytes)})`
              : ''}
          </div>
        ) : null}
        {operation.kind === 'delete' && operation.state === 'succeeded' ? (
          <div>
            {operation.filesRemoved
              ? 'VirtualBox removed the machine and its files.'
              : 'VirtualBox unregistered the machine; it did not confirm that its files were removed.'}{' '}
            The versions and screenshots of this VM are kept.
          </div>
        ) : null}
        {operation.error ? (
          <div
            className={operation.state === 'uncertain' ? 'text-warning-emphasis' : 'text-danger'}
          >
            <span className="vm-identity">{operation.error.code}</span>: {operation.error.message}
          </div>
        ) : null}
        {operation.state === 'uncertain' && operation.kind === 'import' ? (
          <div className="alert alert-warning small mt-1 mb-1" role="alert">
            It is not certain what this import left in VirtualBox, so it is not repeated
            automatically and no machine was linked.
            {operation.strayMachines.length > 0
              ? ' VirtualBox registered these machines meanwhile; check them in VirtualBox. EmuCat removes none of them.'
              : ' Check VirtualBox before importing again.'}
          </div>
        ) : null}
        {operation.state === 'uncertain' && operation.kind === 'delete' ? (
          <div className="alert alert-warning small mt-1 mb-1" role="alert">
            VirtualBox did not confirm the deletion, so the machine is still linked and the deletion
            is not repeated automatically. Check the machine in VirtualBox.
          </div>
        ) : null}
        {operation.strayMachines.length > 0 ? (
          <ul className="mb-1">
            {operation.strayMachines.map((stray) => (
              <li key={stray.uuid}>
                <span className="virtualbox-name">{stray.name || '(unnamed)'}</span>{' '}
                <code className="vm-identity small">{stray.uuid}</code>
              </li>
            ))}
          </ul>
        ) : null}
        {machine && !linked ? (
          <div className="d-flex flex-wrap gap-2 mt-1">
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={busy}
              onClick={() => onLink(operation)}
            >
              {data.source ? 'Replace link with this machine…' : 'Link this machine…'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              disabled={busy}
              aria-haspopup="dialog"
              onClick={() =>
                onDelete({ agentId: operation.agentId, uuid: machine.uuid, name: machine.name })
              }
            >
              Delete imported machine from VirtualBox…
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** The machine of a VirtualBox VM, and what an administrator can do with it. */
export function VirtualBoxSourceSection({ vm }: { vm: VmIdentity }) {
  return (
    <WithVirtualBoxManagement vm={vm}>
      {(management) => <SourceSection vm={vm} management={management} />}
    </WithVirtualBoxManagement>
  );
}

function SourceSection({ vm, management }: { vm: VmIdentity; management: Management }) {
  const [linking, setLinking] = useState<'discovery' | VirtualBoxOperation | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [deleting, setDeleting] = useState<{ agentId: string; uuid: string; name: string } | null>(
    null,
  );
  const changed = () => {
    management.refresh();
    notifyVirtualBoxChanged(vm);
  };
  const data = management.data;
  const source = data?.source ?? null;
  const active = data?.operations.some((item) => isVirtualBoxOperationActive(item.state)) ?? false;
  const poweredOff = source?.state === 'powered_off' && source.present !== false;
  const sourceAgent = data?.agents.find((agent) => agent.agentId === source?.agentId) ?? null;
  const why = !source
    ? null
    : active
      ? 'An import or a deletion is under way.'
      : !poweredOff
        ? 'Power the machine off first.'
        : null;
  const deleteWhy =
    why ??
    (!sourceAgent?.online
      ? 'The agent is offline.'
      : !sourceAgent.management
        ? 'Update the agent to delete machines from VirtualBox.'
        : null);

  return (
    <section className="card" aria-labelledby="vm-virtualbox-heading">
      <div className="card-body">
        <h2 id="vm-virtualbox-heading" className="h6 card-title">
          VirtualBox machine
        </h2>
        {management.error && !data ? (
          <p className="small text-body-secondary">
            The VirtualBox machine is not available right now.
          </p>
        ) : null}
        {!data && !management.error ? (
          <p className="small text-body-secondary">Loading the VirtualBox machine…</p>
        ) : null}
        {data ? (
          <>
            {source ? (
              <dl className="small settings-facts mb-2">
                <dt>Linked to</dt>
                <dd className="virtualbox-name">{source.displayName}</dd>
                <dt>UUID</dt>
                <dd>
                  <code className="vm-identity small">{source.machineUuid}</code>
                </dd>
                <dt>Agent</dt>
                <dd>
                  {source.agentName}{' '}
                  {source.agentOnline ? null : (
                    <span className="badge text-bg-warning">Offline</span>
                  )}
                </dd>
                <dt>State</dt>
                <dd>
                  <MachineState state={source.state} />
                  {source.present === false ? (
                    <span className="badge text-bg-warning ms-1">No longer listed</span>
                  ) : null}
                </dd>
                <dt>Comes from</dt>
                <dd className="vm-identity">
                  {data.sourceVersionId ? data.sourceVersionId.slice(-12) : 'Unknown version'}
                </dd>
              </dl>
            ) : (
              <p className="small">
                Not linked to a VirtualBox machine. Link a machine VirtualBox already has, or import
                a version into VirtualBox from the version history: the new machine is linked once
                the import succeeds.
              </p>
            )}
            <p className="small text-body-secondary">
              The link names the machine by its UUID, and changes only when an administrator changes
              it here, or imports a version and agrees to link the new machine: never because a
              machine has a similar name, and never because an agent disconnects. Changing or
              removing the link never deletes a machine, a version or a screenshot.
            </p>
            <div className="d-flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-sm btn-outline-primary"
                disabled={why !== null}
                aria-haspopup="dialog"
                onClick={() => setLinking('discovery')}
              >
                {source ? 'Change machine…' : 'Link a machine…'}
              </button>
              {source ? (
                <>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary theme-button"
                    disabled={why !== null}
                    aria-haspopup="dialog"
                    onClick={() => setUnlinking(true)}
                  >
                    Unlink…
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    disabled={deleteWhy !== null}
                    aria-haspopup="dialog"
                    onClick={() =>
                      setDeleting({
                        agentId: source.agentId,
                        uuid: source.machineUuid,
                        name: source.displayName,
                      })
                    }
                  >
                    Delete from VirtualBox…
                  </button>
                </>
              ) : null}
            </div>
            {deleteWhy && source ? (
              <p className="small text-body-secondary mt-1 mb-0">Not now: {deleteWhy}</p>
            ) : null}
            {data.operations.length > 0 ? (
              <>
                <h3 className="h6 mt-3">Imports, deletions and links</h3>
                <ul className="list-unstyled mb-0">
                  {data.operations.slice(0, 10).map((operation) => (
                    <OperationItem
                      key={operation.id}
                      operation={operation}
                      data={data}
                      busy={active}
                      onLink={setLinking}
                      onRetryLink={async (item) => {
                        try {
                          await retryVirtualBoxImportLink(vm, item.id);
                        } finally {
                          changed();
                        }
                      }}
                      onDelete={setDeleting}
                    />
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : null}
      </div>
      {linking === 'discovery' && data ? (
        <LinkMachineDialog
          vm={vm}
          data={data}
          onClose={() => setLinking(null)}
          onLinked={() => {
            setLinking(null);
            changed();
          }}
        />
      ) : null}
      {linking && linking !== 'discovery' && data ? (
        <ConfirmDialog
          title={data.source ? 'Replace the link' : 'Link the imported machine'}
          action={data.source ? 'Replace link' : 'Link'}
          onClose={() => setLinking(null)}
          onConfirm={async () => {
            await linkVirtualBoxMachine(vm, {
              agentId: linking.agentId,
              machineUuid: linking.machineUuid as string,
              importOperationId: linking.id,
              replaceMachineUuid: data.source?.machineUuid ?? null,
            });
            setLinking(null);
            changed();
          }}
        >
          <p>
            {vm.vmName} will run from <strong>{linking.machineName}</strong> (
            <code className="vm-identity">{linking.machineUuid}</code>) on {linking.agentName}.
          </p>
          {data.source ? (
            <p className="mb-0">
              It is no longer linked to <strong>{data.source.displayName}</strong>, which stays in
              VirtualBox, unchanged.
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
      {unlinking && source ? (
        <ConfirmDialog
          title={`Unlink ${vm.vmName}`}
          action="Unlink"
          onClose={() => setUnlinking(false)}
          onConfirm={async () => {
            await unlinkVirtualBoxMachine(vm, source.machineUuid);
            setUnlinking(false);
            changed();
          }}
        >
          <p>
            {vm.vmName} will no longer run from <strong>{source.displayName}</strong>. The machine
            stays in VirtualBox, unchanged, and every version and screenshot of {vm.vmName} is kept.
          </p>
          <p className="mb-0">It cannot be run from here until it is linked again.</p>
        </ConfirmDialog>
      ) : null}
      {deleting ? (
        <DeleteMachineDialog
          vm={vm}
          machine={deleting}
          linked={deleting.uuid === source?.machineUuid}
          onClose={() => setDeleting(null)}
          onStarted={() => {
            setDeleting(null);
            changed();
          }}
        />
      ) : null}
    </section>
  );
}

/** A dialog shell that keeps focus inside, closes with Escape, and holds a form. */
function FormDialog({
  title,
  titleId,
  first,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  titleId: string;
  first: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalDialog(dialog, first, onClose);
  return (
    <div className="modal-backdrop-custom">
      <div
        ref={dialog}
        className="card restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <form className="card-body" onSubmit={onSubmit}>
          <h2 id={titleId} className="h5 card-title">
            {title}
          </h2>
          {children}
        </form>
      </div>
    </div>
  );
}

/**
 * Links a machine an agent's latest discovery saw. Only a machine that is powered off and readable can be linked,
 * and only one no other catalog VM is linked to.
 */
function LinkMachineDialog({
  vm,
  data,
  onClose,
  onLinked,
}: {
  vm: VmIdentity;
  data: VirtualBoxManagementResponse;
  onClose: () => void;
  onLinked: () => void;
}) {
  const usable = data.agents.filter((agent) => agent.virtualbox);
  const [agentId, setAgentId] = useState(
    () => data.source?.agentId ?? usable.find((agent) => agent.online)?.agentId ?? '',
  );
  // What the agent's latest discovery said, for the agent it was asked of.
  const [loaded, setLoaded] = useState<{
    agentId: string;
    discovery: DiscoveryOperation | null;
    error: unknown;
  } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const first = useRef<HTMLSelectElement>(null);
  const id = useId();

  useEffect(() => {
    if (!agentId) return;
    const controller = new AbortController();
    fetchDiscovery(agentId, controller.signal)
      .then((response) => setLoaded({ agentId, discovery: response.operation, error: null }))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setLoaded({ agentId, discovery: null, error: failure });
      });
    return () => controller.abort();
  }, [agentId]);
  const current = loaded?.agentId === agentId ? loaded : null;
  const discovery = current?.discovery ?? null;
  const loadError = current?.error ?? null;

  const linkedElsewhere = new Map(
    (discovery?.virtualboxRegistrations ?? []).map((item) => [item.machineUuid, item.vmName]),
  );
  const reasonFor = (machine: VirtualBoxVm): string | null => {
    if (machine.uuid === data.source?.machineUuid) return 'Linked to this VM now';
    const other = linkedElsewhere.get(machine.uuid);
    if (other && other !== vm.vmName) return `Linked to ${other}`;
    if (machine.accessible !== true) return 'VirtualBox cannot read it';
    if (machine.state !== 'powered_off') return 'Power it off first';
    return null;
  };
  const machines = discovery?.virtualbox?.vms ?? [];
  const usableDiscovery = discovery?.status === 'completed' && discovery.expiresAt !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || !discovery) return;
    setBusy(true);
    setError(null);
    try {
      await linkVirtualBoxMachine(vm, {
        agentId,
        machineUuid: chosen,
        discoveryOperationId: discovery.id,
        replaceMachineUuid: data.source?.machineUuid ?? null,
      });
      onLinked();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={data.source ? `Change the machine of ${vm.vmName}` : `Link ${vm.vmName}`}
      titleId={`${id}-title`}
      first={first}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
    >
      <div className="mb-3">
        <label htmlFor={`${id}-agent`} className="form-label small">
          Agent
        </label>
        <select
          id={`${id}-agent`}
          ref={first}
          className="form-select form-select-sm"
          value={agentId}
          onChange={(event) => {
            setAgentId(event.target.value);
            setChosen(null);
          }}
        >
          {usable.length === 0 ? <option value="">No agent can use VirtualBox</option> : null}
          {usable.map((agent: VirtualBoxAgentOption) => (
            <option key={agent.agentId} value={agent.agentId}>
              {agent.agentName}
              {agent.online ? '' : ' (offline)'}
            </option>
          ))}
        </select>
      </div>
      {loadError ? (
        <p className="small text-danger">The agent’s discovery could not be loaded.</p>
      ) : null}
      {agentId && !current ? (
        <p className="small text-body-secondary">Loading the agent’s latest discovery…</p>
      ) : null}
      {discovery && !usableDiscovery ? (
        <p className="small">
          This agent has no recent, completed discovery. Run discovery on its page first.
        </p>
      ) : null}
      {usableDiscovery ? (
        machines.length === 0 ? (
          <p className="small">The agent’s discovery found no VirtualBox machines.</p>
        ) : (
          <fieldset className="mb-3">
            <legend className="form-label small">
              Machine, as seen {formatTime(discovery.finishedAt)}
            </legend>
            {machines.map((machine) => {
              const reason = reasonFor(machine);
              return (
                <div className="form-check small" key={machine.uuid}>
                  <input
                    className="form-check-input"
                    type="radio"
                    name={`${id}-machine`}
                    id={`${id}-${machine.uuid}`}
                    disabled={reason !== null}
                    checked={chosen === machine.uuid}
                    onChange={() => setChosen(machine.uuid)}
                  />
                  <label className="form-check-label" htmlFor={`${id}-${machine.uuid}`}>
                    <span className="virtualbox-name">{machine.name || '(unnamed)'}</span>{' '}
                    <code className="vm-identity small">{machine.uuid}</code>{' '}
                    <span className={`badge ${STATE_BADGE[machine.state]}`}>
                      {STATE_TEXT[machine.state]}
                    </span>
                    {reason ? <span className="text-body-secondary"> — {reason}</span> : null}
                  </label>
                </div>
              );
            })}
          </fieldset>
        )
      ) : null}
      <p className="small text-body-secondary">
        The machine must be powered off. Choose it by its UUID: names are only a hint, and two
        machines can share one.
        {data.source
          ? ` ${data.source.displayName} stays in VirtualBox, unchanged, and is simply no longer linked.`
          : ''}
      </p>
      <FormError error={error} />
      <div className="d-flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy || !chosen}>
          {busy ? 'Working…' : data.source ? 'Replace link' : 'Link'}
        </button>
        <button type="button" className="btn btn-outline-secondary theme-button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </FormDialog>
  );
}

/**
 * Deletes one machine from VirtualBox, with VirtualBox's own `unregistervm --delete`, once its exact name is typed.
 * The agent looks at the machine again just before, and deletes nothing if it changed.
 */
export function DeleteMachineDialog({
  vm,
  machine,
  linked,
  onClose,
  onStarted,
}: {
  vm: VmIdentity;
  machine: { agentId: string; uuid: string; name: string };
  linked: boolean;
  onClose: () => void;
  onStarted: (operation: VirtualBoxOperation) => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const first = useRef<HTMLInputElement>(null);
  const id = useId();
  // Exactly, including case: this is VirtualBox's name, not a catalog name.
  const matches = typed === machine.name;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(
        await deleteFromVirtualBox(vm, {
          agentId: machine.agentId,
          machineUuid: machine.uuid,
          confirmMachineName: typed,
          requestId,
        }),
      );
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={`Delete ${machine.name} from VirtualBox`}
      titleId={`${id}-title`}
      first={first}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
    >
      <div className="alert alert-danger small" role="alert">
        VirtualBox unregisters the machine <code className="vm-identity">{machine.uuid}</code> and
        deletes its files, its disks included. This cannot be undone. The machine must be powered
        off.
      </div>
      <p className="small">
        Every version, OVA and screenshot of {vm.vmName} is kept.{' '}
        {linked
          ? `${vm.vmName} is then no longer linked to a machine; import a version into VirtualBox to run it again.`
          : 'This machine is not the one linked to the VM, which is not changed.'}
      </p>
      <label htmlFor={`${id}-name`} className="form-label small">
        Type <span className="virtualbox-name">{machine.name}</span> exactly to confirm
      </label>
      <input
        id={`${id}-name`}
        ref={first}
        className="form-control mb-3"
        autoComplete="off"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />
      <FormError error={error} />
      <div className="d-flex flex-wrap gap-2">
        <button type="submit" className="btn btn-danger" disabled={busy || !matches}>
          {busy ? 'Working…' : 'Delete from VirtualBox'}
        </button>
        <button type="button" className="btn btn-outline-secondary theme-button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </FormDialog>
  );
}

/**
 * Imports one version's OVA into an agent's VirtualBox as a new machine. Nothing is overwritten or deleted. Once
 * VirtualBox has the machine it is linked to the VM, if the VM has none; if it has one, the administrator chooses to
 * keep that link, or explicitly to replace it, which leaves the old machine in VirtualBox as it is.
 */
export function ImportIntoVirtualBoxDialog({
  vm,
  title,
  version,
  agents,
  source,
  onClose,
  onStarted,
}: {
  vm: VmIdentity;
  /** The VM's title, for the default machine name. */
  title: string;
  version: { id: string; label: string };
  agents: readonly VirtualBoxAgentOption[];
  /** The machine the VM is linked to now, as the page last saw it. */
  source: VirtualBoxManagementResponse['source'];
  onClose: () => void;
  onStarted: (operation: VirtualBoxOperation) => void;
}) {
  const [replace, setReplace] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const sourceIdle =
    source !== null && (source.present === false || source.state === 'powered_off');
  const linkReady = !replace || (sourceIdle && confirmed);
  const capable = agents.filter((agent) => agent.management);
  const [agentId, setAgentId] = useState(
    () => capable.find((agent) => agent.online)?.agentId ?? '',
  );
  const [name, setName] = useState(() => defaultVirtualBoxTargetName(title, version.label));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const first = useRef<HTMLSelectElement>(null);
  const id = useId();
  const validation = validateVirtualBoxTargetName(name);
  const agent = capable.find((item) => item.agentId === agentId) ?? null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validation.ok || !agent?.online || !linkReady) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(
        await importIntoVirtualBox(vm, version.id, {
          agentId,
          targetName: name,
          requestId,
          replaceMachineUuid: source?.machineUuid ?? null,
          replaceSource: source !== null && replace,
        }),
      );
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={`Import ${version.label} into VirtualBox`}
      titleId={`${id}-title`}
      first={first}
      onClose={onClose}
      onSubmit={(event) => void submit(event)}
    >
      <div className="mb-3">
        <label htmlFor={`${id}-agent`} className="form-label small">
          Agent
        </label>
        <select
          id={`${id}-agent`}
          ref={first}
          className="form-select form-select-sm"
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
        >
          {capable.length === 0 ? (
            <option value="">No agent can import into VirtualBox</option>
          ) : null}
          {capable.map((item) => (
            <option key={item.agentId} value={item.agentId}>
              {item.agentName}
              {item.online ? '' : ' (offline)'}
            </option>
          ))}
        </select>
        {agents.some((item) => item.virtualbox && !item.management) ? (
          <div className="form-text">Agents not listed need an update to import.</div>
        ) : null}
      </div>
      <div className="mb-3">
        <label htmlFor={`${id}-name`} className="form-label small">
          Name in VirtualBox
        </label>
        <input
          id={`${id}-name`}
          className={`form-control${validation.ok ? '' : ' is-invalid'}`}
          value={name}
          maxLength={VIRTUALBOX_TARGET_NAME_MAX_LENGTH}
          aria-describedby={`${id}-help`}
          onChange={(event) => setName(event.target.value)}
        />
        <div id={`${id}-help`} className={validation.ok ? 'form-text' : 'invalid-feedback'}>
          {validation.ok
            ? 'A name no machine in that VirtualBox has yet. VirtualBox names the machine’s folder after it.'
            : TARGET_NAME_TEXT[validation.code]}
        </div>
      </div>
      <p className="small">
        The agent downloads this version’s OVA, checks its size and SHA-256, has VirtualBox check
        it, and imports it as a new machine. Nothing already in VirtualBox is changed.
        {source
          ? ''
          : ` Once the import succeeds, the new machine is linked to ${vm.vmName}, and comes from ${version.label}.`}
      </p>
      {source ? (
        <fieldset className="mb-3">
          <legend className="form-label small">
            {vm.vmName} is linked to <span className="virtualbox-name">{source.displayName}</span> (
            <code className="vm-identity small">{source.machineUuid}</code>)
          </legend>
          <div className="form-check small">
            <input
              className="form-check-input"
              type="radio"
              name={`${id}-link`}
              id={`${id}-keep`}
              checked={!replace}
              onChange={() => {
                setReplace(false);
                setConfirmed(false);
              }}
            />
            <label className="form-check-label" htmlFor={`${id}-keep`}>
              Keep this link; leave the new machine unlinked
            </label>
          </div>
          <div className="form-check small">
            <input
              className="form-check-input"
              type="radio"
              name={`${id}-link`}
              id={`${id}-replace`}
              checked={replace}
              onChange={() => setReplace(true)}
            />
            <label className="form-check-label" htmlFor={`${id}-replace`}>
              Replace this link with the new machine
            </label>
          </div>
          {replace ? (
            <div className="alert alert-warning small mt-2 mb-0">
              Once the import succeeds, {vm.vmName} runs from the new machine, which comes from{' '}
              {version.label}, and later snapshots are made from it.{' '}
              <span className="virtualbox-name">{source.displayName}</span> is not deleted or
              changed: it stays in VirtualBox, simply no longer linked. It must be powered off, now
              and when the import finishes; it is never shut down for you.
              {sourceIdle ? null : (
                <div className="mt-1 text-danger">
                  It is not powered off. Shut it down in VirtualBox first.
                </div>
              )}
              <div className="form-check mt-2">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id={`${id}-confirm`}
                  checked={confirmed}
                  disabled={!sourceIdle}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <label className="form-check-label" htmlFor={`${id}-confirm`}>
                  Replace the link to {source.displayName}
                </label>
              </div>
            </div>
          ) : null}
        </fieldset>
      ) : null}
      <p className="small text-body-secondary">
        An import cannot be cancelled once VirtualBox starts it. If its outcome is not certain, it
        is not repeated automatically.
      </p>
      <FormError error={error} />
      <div className="d-flex flex-wrap gap-2">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !validation.ok || !agent?.online || !linkReady}
        >
          {busy ? 'Working…' : replace ? 'Import and replace link' : 'Import'}
        </button>
        <button type="button" className="btn btn-outline-secondary theme-button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </FormDialog>
  );
}
