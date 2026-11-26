import { LoaderCircle, type LucideIcon } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';

/**
 * Icon buttons and toolbars (decision 0058), built on Lucide icons imported one by one. Every button has an accessible
 * name of its own (`label`, as `aria-label`); the tooltip only repeats it for sighted pointer and keyboard users and
 * is hidden from assistive technology, so nothing depends on it. Toggles say their state with `aria-pressed`.
 *
 * Sizes follow Bootstrap's small buttons, with a 2rem (32 px) minimum target, and 2.75rem on coarse pointers.
 * Colours come from Bootstrap's variables, so both themes apply without anything specific here.
 */

export const ICON_SIZE = 16;

interface BaseProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  icon: LucideIcon;
  /** The accessible name, also shown as the tooltip unless `tooltip` says otherwise. */
  label: string;
  tooltip?: string;
  /** Shows a spinning loader instead of the icon, and marks the button busy. */
  loading?: boolean;
  /** Shows the label beside the icon. */
  showLabel?: boolean;
  /** Where the tooltip opens. */
  tooltipPlacement?: 'below' | 'above' | 'start';
  variant?: 'ghost' | 'primary';
  children?: ReactNode;
}

function Content({
  icon: Icon,
  label,
  loading,
  showLabel,
  tooltip,
  tooltipPlacement,
  children,
}: BaseProps) {
  return (
    <>
      {loading ? (
        <LoaderCircle size={ICON_SIZE} aria-hidden="true" className="icon-spin" />
      ) : (
        <Icon size={ICON_SIZE} aria-hidden="true" />
      )}
      {showLabel ? <span className="icon-button-label">{label}</span> : null}
      {children}
      {tooltip !== '' ? (
        <span
          className={`icon-tooltip icon-tooltip-${tooltipPlacement ?? 'below'}`}
          aria-hidden="true"
        >
          {tooltip ?? label}
        </span>
      ) : null}
    </>
  );
}

const className = (props: BaseProps, pressed?: boolean) =>
  [
    'icon-button',
    props.variant === 'primary' ? 'icon-button-primary' : '',
    pressed ? 'icon-button-pressed' : '',
    props.showLabel ? 'icon-button-with-label' : '',
    props.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

const CONTENT_KEYS = [
  'icon',
  'label',
  'tooltip',
  'loading',
  'showLabel',
  'tooltipPlacement',
  'variant',
  'children',
  'className',
  'pressed',
  'onPressedChange',
] as const;

/** The props that go to the `<button>` itself. */
function buttonAttributes(props: object): ButtonHTMLAttributes<HTMLButtonElement> {
  const attributes: Record<string, unknown> = { ...props };
  for (const key of CONTENT_KEYS) delete attributes[key];
  return attributes;
}

export const IconButton = forwardRef<HTMLButtonElement, BaseProps>(function IconButton(props, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...buttonAttributes(props)}
      className={className(props)}
      aria-label={props.label}
      aria-busy={props.loading || undefined}
    >
      <Content {...props} />
    </button>
  );
});

export const IconToggleButton = forwardRef<
  HTMLButtonElement,
  BaseProps & { pressed: boolean; onPressedChange?: (pressed: boolean) => void }
>(function IconToggleButton(props, ref) {
  const { pressed, onPressedChange, onClick } = props;
  return (
    <button
      ref={ref}
      type="button"
      {...buttonAttributes(props)}
      className={className(props, pressed)}
      aria-label={props.label}
      aria-pressed={pressed}
      aria-busy={props.loading || undefined}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onPressedChange?.(!pressed);
      }}
    >
      <Content {...props} />
    </button>
  );
});

const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]';

/**
 * A toolbar (WAI-ARIA): its controls keep their own Tab stops, and Left/Right (Home/End) also move between them, so
 * a long toolbar is quick to cross from the keyboard. Text fields keep their arrow keys.
 */
export function Toolbar({
  label,
  children,
  className: extra,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
    // A popover opened from the toolbar keeps its own keys.
    if (target.closest('.info-popover')) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (control) => !control.closest('.info-popover'),
    );
    const at = controls.indexOf(target);
    if (at < 0) return;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? controls.length - 1
          : event.key === 'ArrowLeft'
            ? Math.max(0, at - 1)
            : Math.min(controls.length - 1, at + 1);
    controls[next]?.focus();
    event.preventDefault();
  };
  return (
    <div
      className={`icon-toolbar ${extra ?? ''}`}
      role="toolbar"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

export function ToolbarGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="icon-toolbar-group" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function ToolbarSeparator() {
  return <div className="icon-toolbar-separator" role="separator" aria-orientation="vertical" />;
}

/** Pushes what follows it to the end of the toolbar. */
export function ToolbarSpacer() {
  return <div className="icon-toolbar-spacer" aria-hidden="true" />;
}
