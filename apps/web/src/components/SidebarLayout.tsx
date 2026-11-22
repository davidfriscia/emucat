import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import type { NavItem } from '../navigation';

const itemClass = ({ isActive }: { isActive: boolean }) =>
  `nav-link sidebar-link${isActive ? ' active' : ''}`;

/** One destination of a sidebar. The current one is highlighted and marked `aria-current="page"`. */
export function SidebarNavItem({ item, onSelect }: { item: NavItem; onSelect?: () => void }) {
  return (
    <li className="nav-item">
      <NavLink to={item.to} end={item.end ?? false} className={itemClass} onClick={onSelect}>
        {item.label}
      </NavLink>
    </li>
  );
}

/**
 * A contextual sidebar beside the page it leads through. On a wide screen the menu is always shown, to the left of
 * the content. On a narrow one it collapses behind a button that names the current destination, and closes again
 * once one is chosen, so that it never takes the width the content needs.
 */
export function SidebarLayout({
  id,
  label,
  header,
  items,
  currentLabel,
  children,
}: {
  /** Unique on the page: names the menu's element for its toggle. */
  id: string;
  /** The menu's accessible name, such as "Admin". */
  label: string;
  /** Shown above the menu, such as the VM it is about. */
  header?: ReactNode;
  items: readonly NavItem[];
  /** The destination that is open, for the collapsed menu's button. */
  currentLabel?: string | undefined;
  children: ReactNode;
}) {
  const location = useLocation();
  // Open only for the location it was opened at: choosing a destination, or going back, closes it.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === location.key;
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = `${id}-menu`;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return;
    setOpenAt(null);
    toggle.current?.focus();
  };

  return (
    <div className="page-wide sidebar-layout">
      <aside className="sidebar" onKeyDown={onKeyDown}>
        {header ? <div className="sidebar-header">{header}</div> : null}
        <button
          ref={toggle}
          type="button"
          className="btn btn-outline-secondary theme-button sidebar-toggle d-lg-none"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpenAt(open ? null : location.key)}
        >
          <span className="sidebar-toggle-label">
            {label} menu
            {currentLabel ? <span className="fw-semibold">: {currentLabel}</span> : null}
          </span>
          <span aria-hidden="true" className="sidebar-toggle-icon">
            {open ? '▴' : '▾'}
          </span>
        </button>
        <nav
          id={menuId}
          aria-label={label}
          className={`sidebar-nav collapse d-lg-block${open ? ' show' : ''}`}
        >
          <ul className="nav nav-pills flex-column">
            {items.map((item) => (
              <SidebarNavItem key={item.to} item={item} onSelect={() => setOpenAt(null)} />
            ))}
          </ul>
        </nav>
      </aside>
      <div className="sidebar-content">{children}</div>
    </div>
  );
}
