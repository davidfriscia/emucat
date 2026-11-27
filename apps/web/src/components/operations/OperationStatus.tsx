import {
  adminVmRoute,
  isVmOperationActive,
  vmOperationKind,
  vmOperationPercent,
  type VmOperation,
} from '@emucat/contracts';
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  CloudOff,
  LoaderCircle,
  Unplug,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { formatBytes, formatTime } from '../Agents';
import { IconButton } from '../ui/IconButton';
import { InfoPopover } from '../ui/Popover';
import { useVmOperations, type VmOperationsValue } from './VmOperationsProvider';
import {
  KIND_TEXT,
  operationOutcomeText,
  operationPhase,
  operationTitle,
  operationTone,
  phaseText,
  statusText,
  type OperationTone,
} from './text';

export { SUCCESS_DISPLAY_MS } from './VmOperationsProvider';

/**
 * How background operations are shown (decision 0060, docs/ui-conventions.md): an animated `LoaderCircle` only while
 * the server says the operation runs and the browser can still ask it; the phase and a measured percentage in words;
 * every fact on demand in an Info-style panel; an explicit notice when it ends.
 */

interface Look {
  icon: LucideIcon;
  spin: boolean;
  tone: OperationTone | 'neutral';
}

/** The icon and tone of an operation, from its recorded state and whether that state is current. */
export function operationLook(entry: VmOperation, unavailable: boolean): Look {
  const active = isVmOperationActive(entry.operation);
  if (active && unavailable) return { icon: CloudOff, spin: false, tone: 'neutral' };
  const phase = operationPhase(entry);
  if (phase === 'waiting_agent') return { icon: Unplug, spin: false, tone: 'warning' };
  if (active) return { icon: LoaderCircle, spin: true, tone: 'info' };
  if (phase === 'completed') return { icon: CircleCheck, spin: false, tone: 'success' };
  if (phase === 'failed') return { icon: CircleX, spin: false, tone: 'danger' };
  return { icon: CircleAlert, spin: false, tone: 'warning' };
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const TRANSPORT_TEXT = {
  server: 'The EmuCat server’s own repository connection',
  sftp: 'Direct SFTP from the agent, as in its latest repository check',
  relay: 'The server’s HTTPS relay, as in the agent’s latest repository check',
} as const;

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="info-facts">
      {rows.map(([term, value]) => (
        <Fragment key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * Everything the server recorded about one operation. Nothing is estimated: a value the server does not hold is not
 * shown, and the one value that is not per operation (the agent's transport) says what it rests on.
 */
export function OperationDetails({
  entry,
  context,
  versionLabel,
}: {
  entry: VmOperation;
  context: Pick<VmOperationsValue, 'unavailable' | 'receivedAt' | 'serverNow' | 'dismiss'>;
  /** The source version's name, when the page knows it. */
  versionLabel?: string | null | undefined;
}) {
  const { operation, relation, transport } = entry;
  const kind = vmOperationKind(operation);
  const active = isVmOperationActive(operation);
  const percent = vmOperationPercent(operation);
  const { doneBytes, totalBytes } = operation.progress;
  const sourceVersion =
    relation === 'clone_source' ? operation.cloneSource?.versionId : operation.parentVersionId;
  const sourceVm = relation === 'clone_source' ? operation.cloneSource?.vmName : operation.vmName;
  // Measured against the server's clock at its latest answer, never the browser's.
  const now = context.serverNow ?? Date.parse(operation.updatedAt);
  const ended = operation.finishedAt ? Date.parse(operation.finishedAt) : null;

  const identity: [string, ReactNode][] = [
    ['Operation', KIND_TEXT[kind]],
    ['Status', statusText(entry)],
    ['Identifier', <code className="vm-identity info-copyable">{operation.id}</code>],
  ];
  if (operation.requestedByDisplayName)
    identity.push(['Requested by', operation.requestedByDisplayName]);

  const subjects: [string, ReactNode][] = [];
  if (sourceVm) subjects.push(['Source VM', <span className="vm-identity">{sourceVm}</span>]);
  if (sourceVersion) {
    subjects.push([
      'Source version',
      <>
        {versionLabel ? `${versionLabel} ` : null}
        <span className="vm-identity" title={sourceVersion}>
          {sourceVersion.slice(0, 8)}
        </span>
      </>,
    ]);
  }
  if (kind === 'clone') {
    subjects.push([
      'Destination VM',
      operation.state === 'succeeded' ? (
        <Link to={adminVmRoute({ emulatorType: operation.emulatorType, vmName: operation.vmName })}>
          {operation.vmName}
        </Link>
      ) : (
        <>
          <span className="vm-identity">{operation.vmName}</span>
          {active ? ' (reserved; created when the clone completes)' : ' (not created)'}
        </>
      ),
    ]);
  }
  if (operation.snapshotName) subjects.push(['New snapshot', operation.snapshotName]);
  subjects.push([
    operation.state === 'succeeded' ? 'Resulting version' : 'Reserved version',
    <>
      <span className="vm-identity" title={operation.versionId}>
        {operation.versionId.slice(0, 8)}
      </span>
      {operation.state === 'succeeded' ? '' : ' (exists only once published)'}
    </>,
  ]);

  const work: [string, ReactNode][] = [
    [
      'Performed by',
      operation.performedBy === 'server'
        ? 'The EmuCat server'
        : `${operation.agentName ?? 'An agent'} (${operation.agentOnline ? 'online' : 'offline'})`,
    ],
    ['Repository', operation.repositoryName],
    ['Transport', transport ? TRANSPORT_TEXT[transport] : 'Not recorded'],
  ];

  const timing: [string, ReactNode][] = [
    ['Started', formatTime(operation.createdAt)],
    ['Last update', formatTime(operation.updatedAt)],
  ];
  if (operation.finishedAt) timing.push(['Finished', formatTime(operation.finishedAt)]);
  timing.push([
    'Elapsed',
    elapsed((ended ?? now) - Date.parse(operation.createdAt)) + (ended ? '' : ' so far'),
  ]);

  return (
    <div className="operation-details">
      {active && context.unavailable ? (
        <p className="operation-stale mb-2" role="note">
          The status cannot be read right now. This is the last state received
          {context.receivedAt ? `, at ${new Date(context.receivedAt).toLocaleTimeString()}` : ''};
          it is asked for again automatically.
        </p>
      ) : null}
      <Facts rows={identity} />
      <h4 className="info-section">Progress</h4>
      {doneBytes !== null && totalBytes !== null && active ? (
        <p className="mb-1">
          {phaseText(entry)}: {formatBytes(doneBytes)} of {formatBytes(totalBytes)}
          {percent !== null ? ` (${percent}%)` : ''}.
        </p>
      ) : (
        <p className="mb-1">
          {active ? `${phaseText(entry)}; this phase is not measured.` : phaseText(entry) + '.'}
        </p>
      )}
      {active ? (
        <p className="info-note mb-0">
          A percentage is the {operation.performedBy === 'server' ? 'server' : 'agent'}’s byte count
          for the current phase only. Verification and publication follow, and the operation is
          complete only when the version is recorded.
        </p>
      ) : null}
      <h4 className="info-section">What it concerns</h4>
      <Facts rows={subjects} />
      <h4 className="info-section">Where it runs</h4>
      <Facts rows={work} />
      <h4 className="info-section">Timing</h4>
      <Facts rows={timing} />
      {operation.error ? (
        <>
          <h4 className="info-section">Failure</h4>
          <p className="mb-1">
            <span className="vm-identity">{operation.error.code}</span>: {operation.error.message}
          </p>
          {operation.recovery ? <p className="info-note mb-0">{operation.recovery}</p> : null}
        </>
      ) : null}
      <p className="info-note mt-2 mb-0">
        {active && operation.performedBy === 'agent'
          ? 'It can be cancelled from Admin › Registrations while nothing is committed. '
          : ''}
        The full record stays in <Link to="/admin/registrations">Registrations</Link>.
      </p>
      {!active ? (
        <div className="mt-2">
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary theme-button"
            onClick={() => context.dismiss(operation.id)}
          >
            Dismiss notice
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The accessible name of an operation's indicator: what, on which version, and where it stands. */
function indicatorLabel(entry: VmOperation, subject: string | null, unavailable: boolean): string {
  const on = subject ? ` of ${subject}` : '';
  const stale = unavailable && isVmOperationActive(entry.operation) ? ', status unavailable' : '';
  return `${operationTitle(entry)}${on}: ${statusText(entry)}${stale}`;
}

/**
 * One operation: its animated or final icon, its title and, while it runs, its phase and measured percentage; its
 * details on demand. `subject` is the version it is drawn on, which its accessible name includes.
 */
export function OperationIndicator({
  entry,
  subject,
  align = 'end',
}: {
  entry: VmOperation;
  subject: string | null;
  align?: 'start' | 'end';
}) {
  const operations = useVmOperations();
  if (!operations) return null;
  const { unavailable } = operations;
  const look = operationLook(entry, unavailable);
  const active = isVmOperationActive(entry.operation);
  return (
    <InfoPopover
      icon={look.icon}
      iconClassName={look.spin ? 'icon-spin' : undefined}
      buttonClassName={`operation-indicator operation-tone-${look.tone}`}
      text={`${operationTitle(entry)}${active ? ` · ${statusText(entry)}` : ''}${active && unavailable ? ' · status unavailable' : ''}`}
      label={indicatorLabel(entry, subject, unavailable)}
      tooltip="Operation details"
      tooltipPlacement={align === 'end' ? 'start' : 'below'}
      title={operationTitle(entry)}
      align={align}
      wide
    >
      {() => <OperationDetails entry={entry} context={operations} versionLabel={subject} />}
    </InfoPopover>
  );
}

/**
 * The operations drawn on one version, at the end of its toolbar beside Info: one indicator each, or one for all when
 * there are several, so that the card never grows by more than one control.
 */
export function VersionOperations({
  versionId,
  versionName,
}: {
  versionId: string;
  versionName: string;
}) {
  const operations = useVmOperations();
  if (!operations) return null;
  const list = operations.forVersion(versionId);
  if (list.length === 0) return null;
  const { unavailable } = operations;
  if (list.length === 1) {
    return <OperationIndicator entry={list[0] as VmOperation} subject={versionName} />;
  }
  const running = list.filter((entry) => isVmOperationActive(entry.operation)).length;
  const first = list.find((entry) => isVmOperationActive(entry.operation)) ?? list[0];
  const look = operationLook(first as VmOperation, unavailable);
  const summary =
    running > 0 ? `${running} of ${list.length} operations running` : `${list.length} operations`;
  return (
    <InfoPopover
      icon={look.icon}
      iconClassName={look.spin ? 'icon-spin' : undefined}
      buttonClassName={`operation-indicator operation-tone-${look.tone}`}
      text={summary}
      label={`Operations of ${versionName}: ${summary}`}
      tooltip="Operation details"
      tooltipPlacement="start"
      title={`Operations of ${versionName}`}
      wide
    >
      {() => <OperationList entries={list} context={operations} versionLabel={() => versionName} />}
    </InfoPopover>
  );
}

function OperationList({
  entries,
  context,
  versionLabel,
}: {
  entries: VmOperation[];
  context: VmOperationsValue;
  versionLabel: (entry: VmOperation) => string | null;
}) {
  return (
    <ul className="operation-list">
      {entries.map((entry) => {
        const look = operationLook(entry, context.unavailable);
        const Icon = look.icon;
        const label = versionLabel(entry);
        return (
          <li key={entry.operation.id} className="operation-list-item">
            <h4 className={`operation-list-title operation-tone-${look.tone}`}>
              <Icon size={14} aria-hidden="true" className={look.spin ? 'icon-spin' : undefined} />
              {operationTitle(entry)}
              {label ? <span className="text-body-secondary"> · {label}</span> : null}
            </h4>
            <OperationDetails entry={entry} context={context} versionLabel={label} />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The page's own indicator of every shown operation, in its header: it is how an operation on a collapsed branch, on
 * no single version (a remaster), or several at once are found. Nothing is drawn when there is nothing to show.
 */
export function OperationsSummary({
  versionLabel = () => null,
}: {
  /** The name of the version an operation is drawn on, when the page knows the versions. */
  versionLabel?: (entry: VmOperation) => string | null;
}) {
  const operations = useVmOperations();
  if (!operations) return null;
  const { visible, unavailable } = operations;
  if (visible.length === 0) {
    if (!unavailable) return null;
    return (
      <span className="status-chip status-chip-neutral operation-summary-unavailable" role="note">
        <CloudOff size={14} aria-hidden="true" />
        <span>Operation status unavailable</span>
      </span>
    );
  }
  const running = visible.filter((entry) => isVmOperationActive(entry.operation));
  const first = (running[0] ?? visible[0]) as VmOperation;
  const look =
    unavailable && running.length > 0
      ? { icon: CloudOff, spin: false, tone: 'neutral' as const }
      : operationLook(first, unavailable);
  const text =
    running.length > 0
      ? running.length === 1
        ? '1 operation running'
        : `${running.length} operations running`
      : visible.length === 1
        ? '1 recent operation'
        : `${visible.length} recent operations`;
  return (
    <InfoPopover
      icon={look.icon}
      iconClassName={look.spin ? 'icon-spin' : undefined}
      buttonClassName={`operation-indicator operation-summary operation-tone-${look.tone}`}
      text={unavailable && running.length > 0 ? `${text} · status unavailable` : text}
      label={`Operations of this VM: ${text}${unavailable ? ', status unavailable' : ''}`}
      tooltip="Operations of this VM"
      tooltipPlacement="start"
      title="Operations of this VM"
      wide
    >
      {() => <OperationList entries={visible} context={operations} versionLabel={versionLabel} />}
    </InfoPopover>
  );
}

/**
 * The explicit end of each shown operation that ended: a success or a failure stays in view, with what to do, until
 * dismissed (a success for {@link SUCCESS_DISPLAY_MS} at most). Announced once by the provider's live region, not
 * here, so nothing is read twice.
 */
export function OperationNotices() {
  const operations = useVmOperations();
  if (!operations) return null;
  const ended = operations.visible.filter((entry) => !isVmOperationActive(entry.operation));
  if (ended.length === 0) return null;
  return (
    <ul className="operation-notices" aria-label="Ended operations">
      {ended.map((entry) => {
        const { operation } = entry;
        const look = operationLook(entry, false);
        const Icon = look.icon;
        const tone = operationTone(entry);
        return (
          <li
            key={operation.id}
            className={`operation-notice alert alert-${tone === 'info' ? 'info' : tone} small`}
          >
            <Icon size={16} aria-hidden="true" className="operation-notice-icon" />
            <div className="operation-notice-text">
              <strong>{operationOutcomeText(entry)}</strong>
              {operation.finishedAt ? (
                <span className="text-body-secondary"> · {formatTime(operation.finishedAt)}</span>
              ) : null}
              {operation.error ? (
                <div>
                  {operation.error.message}
                  {operation.recovery ? (
                    <div className="text-body-secondary">{operation.recovery}</div>
                  ) : null}
                </div>
              ) : null}
              {operation.mode === 'clone' && operation.state === 'succeeded' ? (
                <div>
                  <Link
                    to={adminVmRoute({
                      emulatorType: operation.emulatorType,
                      vmName: operation.vmName,
                    })}
                  >
                    Open {operation.vmName}
                  </Link>
                </div>
              ) : null}
            </div>
            <IconButton
              icon={X}
              label={`Dismiss: ${operationOutcomeText(entry)}`}
              tooltip="Dismiss"
              tooltipPlacement="start"
              className="operation-notice-dismiss"
              onClick={() => operations.dismiss(operation.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}
