import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { ApiStatusBadge } from './ApiStatusBadge';
import { BrandMark } from './BrandMark';
import { ThemeButton } from './ThemeButton';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `nav-link${isActive ? ' active' : ''}`;

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="d-flex flex-column min-vh-100">
      <nav className="navbar navbar-expand-md border-bottom bg-body-tertiary">
        <div className="container">
          <Link to="/" className="navbar-brand d-flex align-items-center gap-2" onClick={closeMenu}>
            <BrandMark />
            <span className="brand-wordmark">EmuCat</span>
          </Link>
          <button
            type="button"
            className="navbar-toggler"
            aria-controls="main-navigation"
            aria-expanded={menuOpen}
            aria-label="Toggle navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="navbar-toggler-icon" />
          </button>
          <div
            id="main-navigation"
            className={`navbar-collapse collapse${menuOpen ? ' show' : ''}`}
          >
            <ul className="navbar-nav me-auto">
              <li className="nav-item">
                <NavLink to="/" end className={navLinkClass} onClick={closeMenu}>
                  Catalog
                </NavLink>
              </li>
              <li className="nav-item">
                <NavLink to="/settings" className={navLinkClass} onClick={closeMenu}>
                  Settings
                </NavLink>
              </li>
            </ul>
            <div className="d-flex flex-wrap align-items-center gap-3 py-2 py-md-0">
              <ApiStatusBadge />
              <ThemeButton />
              <NavLink to="/login" className="btn btn-sm btn-primary" onClick={closeMenu}>
                Sign in
              </NavLink>
            </div>
          </div>
        </div>
      </nav>
      <main className="container flex-grow-1 py-4">
        <Outlet />
      </main>
    </div>
  );
}
