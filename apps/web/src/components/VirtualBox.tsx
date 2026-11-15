import type {
  VirtualBoxDiscovery,
  VirtualBoxDiscoveryStatus,
  VirtualBoxVm,
  VirtualBoxVmError,
  VirtualBoxVmState,
} from '@emucat/contracts';
import { EmptyState } from './States';
import { formatTime } from './Agents';

const STATE_TEXT: Record<VirtualBoxVmState, string> = {
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

const STATE_BADGE: Record<VirtualBoxVmState, string> = {
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

/**
 * What VirtualBox reported, apart from the directory scan: these machines were not found under a base
 * path, and none is a catalog entry. VB1 only observes them, so nothing here starts or registers one.
 */
export function VirtualBoxMachines({
  virtualbox,
  observedAt,
  stale,
}: {
  /** `null` when the agent does not report on VirtualBox at all. */
  virtualbox: VirtualBoxDiscovery | null;
  observedAt: string | null;
  stale: boolean;
}) {
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
