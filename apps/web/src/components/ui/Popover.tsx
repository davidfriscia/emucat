import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconToggleButton } from './IconButton';

/**
 * A button that opens a small panel of information over the content, without moving it (decision 0058). The panel is
 * a non-modal dialog named by `title`: Escape or the button closes it and gives the focus back to the button; a click
 * outside closes it too. Escape used here never reaches an enclosing modal, which therefore stays open.
 */
export function InfoPopover({
  icon,
  label,
  title,
  children,
  align = 'end',
  disabled,
  wide,
}: {
  icon: LucideIcon;
  /** The button's accessible name, such as "File information". */
  label: string;
  /** The panel's heading and accessible name. */
  title: string;
  children: ReactNode | (() => ReactNode);
  align?: 'start' | 'end';
  disabled?: boolean;
  wide?: boolean;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div
      className="info-popover-root"
      ref={root}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <IconToggleButton
        ref={button}
        icon={icon}
        label={label}
        pressed={open}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? `${ids}-panel` : undefined}
        aria-haspopup="dialog"
        onPressedChange={setOpen}
        tooltip={open ? '' : undefined}
      />
      {open ? (
        <div
          ref={panel}
          id={`${ids}-panel`}
          className={`info-popover info-popover-${align} ${wide ? 'info-popover-wide' : ''}`}
          role="dialog"
          aria-labelledby={`${ids}-title`}
          tabIndex={-1}
        >
          <h3 id={`${ids}-title`} className="info-popover-title">
            {title}
          </h3>
          <div className="info-popover-body">
            {typeof children === 'function' ? children() : children}
          </div>
        </div>
      ) : null}
    </div>
  );
}
