import type { LucideIcon } from 'lucide-react';
import { ICON_SIZE } from './IconButton';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * A compact status indicator: an icon and a short visible label, never colour alone. The complete statement (`detail`)
 * is in the text for assistive technology and in a tooltip for pointer users; anything a person may need to act on is
 * also in the Info panel next to it, which is the one way to read it on a touch screen.
 */
export function StatusChip({
  icon: Icon,
  label,
  detail,
  tone = 'neutral',
}: {
  icon: LucideIcon;
  /** Visible, a few words. */
  label: string;
  /** The full statement. Defaults to the label. */
  detail?: string;
  tone?: StatusTone;
}) {
  const full = detail && detail !== label ? detail : null;
  return (
    <span className={`status-chip status-chip-${tone}`}>
      <Icon size={ICON_SIZE - 2} aria-hidden="true" />
      <span aria-hidden={full !== null || undefined}>{label}</span>
      {full !== null ? (
        // The one copy of the statement: read by assistive technology, shown as the tooltip on hover.
        <span className="icon-tooltip icon-tooltip-wrap icon-tooltip-below">{full}</span>
      ) : null}
    </span>
  );
}
