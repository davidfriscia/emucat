import { LoaderCircle, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

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
  /**
   * Visible text beside the icon, when it should be shorter than the accessible name (an operation's status, whose
   * name also says what it concerns). The name stays `label`.
   */
  text?: string;
  /** A class for the icon, such as `icon-spin` for an animated indicator. */
  iconClassName?: string;
  /** Where the tooltip opens. */
  tooltipPlacement?: 'below' | 'above' | 'start';
  variant?: 'ghost' | 'primary';
  /**
   * Why the button cannot be used now, given with `disabled`. The button then stays focusable and is marked
   * `aria-disabled` instead, so that its explanation can be reached by keyboard and is announced as its description;
   * it never acts while disabled. Without a reason, `disabled` is the native attribute.
   */
  disabledReason?: string | null | undefined;
  /** Danger styling on hover and focus only, for a destructive action that stays neutral at rest. */
  danger?: boolean;
  children?: ReactNode;
}

function Content({
  icon: Icon,
  label,
  loading,
  showLabel,
  text,
  iconClassName,
  tooltip,
  tooltipPlacement,
  children,
  reason,
  reasonId,
}: BaseProps & { reason: string | null; reasonId: string }) {
  return (
    <>
      {loading ? (
        <LoaderCircle size={ICON_SIZE} aria-hidden="true" className="icon-spin" />
      ) : (
        <Icon size={ICON_SIZE} aria-hidden="true" className={iconClassName} />
      )}
      {text !== undefined ? (
        <span className="icon-button-label" aria-hidden="true">
          {text}
        </span>
      ) : showLabel ? (
        <span className="icon-button-label">{label}</span>
      ) : null}
      {children}
      {reason !== null ? (
        // The reason is written once: it is the button's description (aria-describedby names it) and the tooltip's
        // text. Only the tooltip's title is hidden, since the button's name already says it.
        <span
          className={`icon-tooltip icon-tooltip-wrap icon-tooltip-${tooltipPlacement ?? 'below'}`}
        >
          <span className="icon-tooltip-title" aria-hidden="true">
            {tooltip || label} unavailable
          </span>
          <span id={reasonId}>{reason}</span>
        </span>
      ) : tooltip !== '' ? (
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
    props.showLabel || props.text !== undefined ? 'icon-button-with-label' : '',
    props.danger ? 'icon-button-danger' : '',
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
  'text',
  'iconClassName',
  'tooltipPlacement',
  'variant',
  'children',
  'className',
  'pressed',
  'onPressedChange',
  'disabledReason',
  'danger',
] as const;

/** The props that go to the `<button>` itself. */
function buttonAttributes(props: object): ButtonHTMLAttributes<HTMLButtonElement> {
  const attributes: Record<string, unknown> = { ...props };
  for (const key of CONTENT_KEYS) delete attributes[key];
  return attributes;
}

/** The reason a disabled button explains, or `null` when it is enabled or has none. */
function reasonOf(props: BaseProps): string | null {
  return props.disabled && props.disabledReason ? props.disabledReason : null;
}

/**
 * The attributes that make a disabled button with a reason focusable but inert: `aria-disabled`, its reason as the
 * description, and a click that is stopped before any handler of the caller's runs.
 */
function disabledAttributes(
  props: BaseProps,
  reason: string | null,
  reasonId: string,
): ButtonHTMLAttributes<HTMLButtonElement> {
  if (reason === null) return {};
  const describedBy = [props['aria-describedby'], reasonId].filter(Boolean).join(' ');
  return {
    disabled: false,
    'aria-disabled': true,
    'aria-describedby': describedBy,
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

export const IconButton = forwardRef<HTMLButtonElement, BaseProps>(function IconButton(props, ref) {
  const reasonId = `${useId()}-reason`;
  const reason = reasonOf(props);
  return (
    <button
      ref={ref}
      type="button"
      {...buttonAttributes(props)}
      {...disabledAttributes(props, reason, reasonId)}
      className={className(props)}
      aria-label={props.label}
      aria-busy={props.loading || undefined}
    >
      <Content {...props} reason={reason} reasonId={reasonId} />
    </button>
  );
});

export const IconToggleButton = forwardRef<
  HTMLButtonElement,
  BaseProps & { pressed: boolean; onPressedChange?: (pressed: boolean) => void }
>(function IconToggleButton(props, ref) {
  const { pressed, onPressedChange, onClick } = props;
  const reasonId = `${useId()}-reason`;
  const reason = reasonOf(props);
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
      {...disabledAttributes(props, reason, reasonId)}
    >
      <Content {...props} reason={reason} reasonId={reasonId} />
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

/**
 * A link that looks like an {@link IconButton}: navigation stays a link (decision 0060), so it opens in a new tab,
 * can be copied and is announced as one. Its name is `label`; the tooltip repeats it and is hidden from readers.
 */
export function IconLink({
  icon: Icon,
  label,
  tooltip,
  tooltipPlacement,
  to,
  className: extra,
}: {
  icon: LucideIcon;
  label: string;
  tooltip?: string;
  tooltipPlacement?: 'below' | 'above' | 'start';
  to: string;
  className?: string;
}) {
  return (
    <Link to={to} className={`icon-button icon-link ${extra ?? ''}`} aria-label={label}>
      <Icon size={ICON_SIZE} aria-hidden="true" />
      <span
        className={`icon-tooltip icon-tooltip-${tooltipPlacement ?? 'below'}`}
        aria-hidden="true"
      >
        {tooltip ?? label}
      </span>
    </Link>
  );
}
