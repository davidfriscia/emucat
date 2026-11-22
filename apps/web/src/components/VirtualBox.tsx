import {
  adminVmRoute,
  validateVmName,
  VM_NAME_MAX_LENGTH,
  type RegistrationOperation,
  type RepositorySummary,
  type VirtualBoxDiscovery,
  type VirtualBoxDiscoveryStatus,
  type VirtualBoxVm,
  type VirtualBoxVmError,
  type VirtualBoxVmState,
  type VmNameErrorCode,
} from '@emucat/contracts';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { startRegistration } from '../api';
import { EmptyState, FormError } from './States';
import { formatTime } from './Agents';

export const STATE_TEXT: Record<VirtualBoxVmState, string> = {
  powered_off: 'Powered off',
  running: 'Running',
  paused: 'Paused',
  saved: 'Saved',
  starting: 'Starting',
  stopping: 'Stopping',
  aborted: 'Aborted',
  stuck: 'Stuck',
  busy: 'Busy',
  inaccessible: 'Inaccessible',
  unknown: 'Unknown',
};

export const STATE_BADGE: Record<VirtualBoxVmState, string> = {
  powered_off: 'text-bg-secondary',
  running: 'text-bg-success',
  paused: 'text-bg-info',
  saved: 'text-bg-info',
  starting: 'text-bg-primary',
  stopping: 'text-bg-primary',
  aborted: 'text-bg-danger',
  stuck: 'text-bg-danger',
  busy: 'text-bg-primary',
  inaccessible: 'text-bg-warning',
  unknown: 'text-bg-dark border',
};

const STATUS_TEXT: Record<Exclude<VirtualBoxDiscoveryStatus, 'ok'>, string> = {
  not_configured: 'VirtualBox is not configured on this agent.',
  executable_missing: 'The configured VBoxManage cannot be found or started on this agent.',
  unrecognized_version: 'VBoxManage did not report a VirtualBox version the agent recognizes.',
  unrecognized_output: 'VBoxManage listed its machines in a form the agent does not recognize.',
  command_failed: 'VBoxManage reported an error, so no machines could be listed.',
  timeout: 'VBoxManage did not answer in time, so no machines could be listed.',
  invalid_report: 'The agent’s VirtualBox report failed validation, and was set aside.',
};

const ERROR_TEXT: Record<VirtualBoxVmError, string> = {
  inspection_failed: 'Could not be inspected',
  timeout: 'Inspection timed out',
  vanished: 'Unregistered during discovery',
  not_inspected: 'Not inspected: the time limit was reached',
};

function StateBadge({ vm }: { vm: VirtualBoxVm }) {
  // A state this page does not know is shown as VirtualBox named it.
  const text =
    vm.state === 'unknown' && vm.rawState ? `Unknown (${vm.rawState})` : STATE_TEXT[vm.state];
  return <span className={`badge ${STATE_BADGE[vm.state]}`}>{text}</span>;
}

function Accessibility({ vm }: { vm: VirtualBoxVm }) {
  const label =
    vm.accessible === true ? 'Accessible' : vm.accessible === false ? 'Inaccessible' : 'Unknown';
  return (
    <>
      <span className={vm.accessible === false ? 'text-warning-emphasis' : undefined}>{label}</span>
      {vm.error ? <div className="small text-body-secondary">{ERROR_TEXT[vm.error]}</div> : null}
    </>
  );
}

/** What to do about a name the VM name rules refuse. */
export const NAME_ERROR_TEXT: Record<VmNameErrorCode, string> = {
  empty: 'Choose a name.',
  invalid_characters: 'Use letters, digits, spaces, dots, hyphens and underscores only.',
  too_long: `Use at most ${VM_NAME_MAX_LENGTH} characters.`,
  invalid_boundary: 'Start and end with a letter or a digit.',
  repeated_separator: 'Do not repeat dots or spaces.',
  reserved_name: 'This name is reserved by Windows.',
  snapshot_suffix: 'This ending is reserved for snapshot names.',
};

/** A catalog name from VirtualBox's name for a machine: only what VM names allow, and never empty. */
export function catalogNameFor(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/[ ._-]*-[ ._-]*/g, '-')
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .slice(0, VM_NAME_MAX_LENGTH)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  return validateVmName(slug).ok ? slug : 'virtualbox-vm';
}

/** Where a discovered machine may be registered from, when it may. */
export interface VirtualBoxRegistering {
  agentId: string;
  agentName: string;
  discoveryOperationId: string;
  repository: RepositorySummary;
  onStarted: (operation: RegistrationOperation) => void;
}

/**
 * Registers one machine: an OVA export becomes its master. The administrator chooses the catalog name; the
 * machine is named to the agent by its UUID only.
 */
export function VirtualBoxRegistrationDialog({
  vm,
  registering,
  onClose,
}: {
  vm: VirtualBoxVm;
  registering: VirtualBoxRegistering;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => catalogNameFor(vm.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const nameId = useId();
  const validation = validateVmName(name);

  useEffect(() => {
    cancel.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validation.ok) return;
    setBusy(true);
    setError(null);
    try {
      registering.onStarted(
        await startRegistration({
          agentId: registering.agentId,
          repositoryId: registering.repository.id,
          emulatorType: 'virtualbox',
          vmName: name,
          mode: 'copy',
          discoveryOperationId: registering.discoveryOperationId,
          virtualboxUuid: vm.uuid,
        }),
      );
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="modal-backdrop show" />
      <div
        className="modal d-block"
        role="dialog"
        aria-modal="true"
        aria-labelledby="virtualbox-registration-title"
        tabIndex={-1}
      >
        <div className="modal-dialog modal-dialog-scrollable">
          <form className="modal-content" onSubmit={(event) => void submit(event)}>
            <div className="modal-header">
              <h2 className="modal-title h5" id="virtualbox-registration-title">
                Register a VirtualBox machine
              </h2>
            </div>
            <div className="modal-body">
              <dl className="settings-facts small">
                <dt>Machine</dt>
                <dd className="virtualbox-name">{vm.name || '(unnamed)'}</dd>
                <dt>UUID</dt>
                <dd>
                  <code className="vm-identity small">{vm.uuid}</code>
                </dd>
                <dt>Agent</dt>
                <dd>{registering.agentName}</dd>
                <dt>Repository</dt>
                <dd>
                  {registering.repository.name} ({registering.repository.host}:
                  {registering.repository.port})
                </dd>
              </dl>
              <div className="mb-3">
                <label htmlFor={nameId} className="form-label">
                  Catalog name
                </label>
                <input
                  id={nameId}
                  className={`form-control${validation.ok ? '' : ' is-invalid'}`}
                  value={name}
                  maxLength={VM_NAME_MAX_LENGTH}
                  aria-describedby={`${nameId}-help`}
                  onChange={(event) => setName(event.target.value)}
                />
                <div
                  id={`${nameId}-help`}
                  className={validation.ok ? 'form-text' : 'invalid-feedback'}
                >
                  {validation.ok
                    ? 'The VM’s name in the catalog. It need not match VirtualBox’s name, and renaming the machine in VirtualBox later changes nothing here.'
                    : NAME_ERROR_TEXT[validation.code]}
                </div>
              </div>
              <p>
                The agent exports this machine with VirtualBox into an OVA, uploads it directly to
                the repository, and verifies it there. That OVA is the master. The machine itself
                stays in VirtualBox, unchanged, and runs from there.
              </p>
              <p className="small text-body-secondary">
                The machine must stay powered off until the export finishes: if it is started
                meanwhile, nothing is registered. The OVA holds the machine’s current state only,
                not its VirtualBox snapshots or saved state. Remote modes and EmuCat snapshots are
                not available for VirtualBox machines.
              </p>
              <FormError error={error} />
            </div>
            <div className="modal-footer">
              <button
                ref={cancel}
                type="button"
                className="btn btn-outline-secondary theme-button"
                onClick={onClose}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !validation.ok}>
                Export and register
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

function CatalogCell({
  vm,
  registered,
  registering,
  stale,
  onRegister,
}: {
  vm: VirtualBoxVm;
  registered: string | undefined;
  registering: VirtualBoxRegistering | null;
  stale: boolean;
  onRegister: () => void;
}) {
  if (registered) {
    return (
      <Link
        className="vm-identity"
        to={adminVmRoute({ emulatorType: 'virtualbox', vmName: registered })}
      >
        {registered}
      </Link>
    );
  }
  const reason = stale
    ? 'Run discovery again first'
    : !registering
      ? null
      : vm.accessible !== true
        ? 'VirtualBox cannot read it'
        : vm.state !== 'powered_off'
          ? 'Power it off first'
          : null;
  if (!registering) return <span className="text-body-secondary">Not registered</span>;
  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-outline-primary"
        disabled={reason !== null}
        aria-label={`Register ${vm.name || vm.uuid}`}
        onClick={onRegister}
      >
        Register…
      </button>
      {reason ? <div className="small text-body-secondary">{reason}</div> : null}
    </>
  );
}

/**
 * What VirtualBox reported, apart from the directory scan: these machines were not found under a base
 * path. A powered-off machine can be registered, which exports it into an OVA master (decision 0045);
 * nothing here ever starts, stops or changes one.
 */
export function VirtualBoxMachines({
  virtualbox,
  observedAt,
  stale,
  registrations = [],
  registering = null,
}: {
  /** `null` when the agent does not report on VirtualBox at all. */
  virtualbox: VirtualBoxDiscovery | null;
  observedAt: string | null;
  stale: boolean;
  /** The machines of this agent already in the catalog, and their catalog names. */
  registrations?: readonly { machineUuid: string; vmName: string }[];
  /** `null` when nothing can be registered from here now. */
  registering?: VirtualBoxRegistering | null;
}) {
  const [chosen, setChosen] = useState<VirtualBoxVm | null>(null);
  const registeredAs = new Map(registrations.map((item) => [item.machineUuid, item.vmName]));
  if (virtualbox === null) {
    return (
      <section className="mt-4" aria-labelledby="virtualbox-heading">
        <h3 className="h6" id="virtualbox-heading">
          VirtualBox — Discovered machines
        </h3>
        <p className="small text-body-secondary mb-0">
          This agent does not report VirtualBox machines. An updated agent does, once VirtualBox is
          configured on it.
        </p>
      </section>
    );
  }
  const { status, version, truncated, vms } = virtualbox;
  return (
    <section className="mt-4" aria-labelledby="virtualbox-heading">
      <h3 className="h6 d-flex flex-wrap align-items-center gap-2" id="virtualbox-heading">
        VirtualBox — Discovered machines
        {version ? (
          <span className="badge text-bg-dark border emulator-badge">VirtualBox {version}</span>
        ) : null}
      </h3>
      {status === 'not_configured' ? (
        <p className="small text-body-secondary mb-0">{STATUS_TEXT.not_configured}</p>
      ) : status !== 'ok' ? (
        <div className="alert alert-warning small" role="alert">
          {STATUS_TEXT[status]} The 86Box and QEMU results above are not affected.
        </div>
      ) : (
        <>
          <p className="small text-body-secondary">
            Every machine registered with VirtualBox for the account the agent runs as
            {observedAt ? `, as observed at ${formatTime(observedAt)}` : ''}. States change as
            machines are used.
            {stale ? ' This report may be out of date: run discovery again.' : ''}
          </p>
          {truncated ? (
            <div className="alert alert-warning small" role="alert">
              Not every machine is described, because a limit on the report’s size or duration was
              reached.
            </div>
          ) : null}
          {vms.length === 0 ? (
            <EmptyState title="No VirtualBox machines">
              VirtualBox is installed, and has no registered machines.
            </EmptyState>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm small align-middle mb-0 virtualbox-machines">
                <caption className="visually-hidden">Machines registered with VirtualBox</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">UUID</th>
                    <th scope="col">Guest OS</th>
                    <th scope="col">State</th>
                    <th scope="col">Status</th>
                    <th scope="col">Catalog</th>
                  </tr>
                </thead>
                <tbody>
                  {vms.map((vm) => (
                    <tr key={vm.uuid}>
                      <td className="virtualbox-name">{vm.name || '(unnamed)'}</td>
                      <td>
                        <code className="vm-identity small">{vm.uuid}</code>
                      </td>
                      <td>{vm.osType ?? <span className="text-body-secondary">—</span>}</td>
                      <td>
                        <StateBadge vm={vm} />
                      </td>
                      <td>
                        <Accessibility vm={vm} />
                      </td>
                      <td>
                        <CatalogCell
                          vm={vm}
                          registered={registeredAs.get(vm.uuid)}
                          registering={registering}
                          stale={stale}
                          onRegister={() => setChosen(vm)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {chosen && registering ? (
        <VirtualBoxRegistrationDialog
          vm={chosen}
          registering={{
            ...registering,
            onStarted: (operation) => {
              setChosen(null);
              registering.onStarted(operation);
            },
          }}
          onClose={() => setChosen(null)}
        />
      ) : null}
    </section>
  );
}
