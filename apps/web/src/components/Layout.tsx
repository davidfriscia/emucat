import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth';
import { ApiStatusBadge } from './ApiStatusBadge';
import { BrandLogo } from './Brand';
import { ThemeButton } from './ThemeButton';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `nav-link${isActive ? ' active' : ''}`;

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  const { state, signOut } = useAuth();
  const navigate = useNavigate();
  const session = state.status === 'authenticated' ? state.session : null;
  const isAdmin = session?.user.role === 'admin';

  const handleSignOut = async () => {
    closeMenu();
    // Leave first: a private page would otherwise react to the sign-out by redirecting to sign-in.
    await navigate('/');
    await signOut();
  };

  return (
    <div className="d-flex flex-column min-vh-100">
      <nav className="navbar navbar-expand-xl border-bottom bg-body-tertiary">
        <div className="container">
          <Link to="/" className="navbar-brand" onClick={closeMenu}>
            <BrandLogo />
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
              {isAdmin ? (
                <>
                  <li className="nav-item">
                    <NavLink to="/admin" end className={navLinkClass} onClick={closeMenu}>
                      Dashboard
                    </NavLink>
                  </li>
                  <li className="nav-item">
                    <NavLink to="/admin/catalog" className={navLinkClass} onClick={closeMenu}>
                      Manage
                    </NavLink>
                  </li>
                  <li className="nav-item">
                    <NavLink to="/admin/agents" className={navLinkClass} onClick={closeMenu}>
                      Agents
                    </NavLink>
                  </li>
                </>
              ) : null}
              {session ? (
                <li className="nav-item">
                  <NavLink to="/settings" className={navLinkClass} onClick={closeMenu}>
                    Settings
                  </NavLink>
                </li>
              ) : null}
            </ul>
            <div className="d-flex flex-wrap align-items-center gap-3 py-2 py-xl-0">
              <ApiStatusBadge />
              <ThemeButton />
              {session ? (
                <>
                  <NavLink
                    to="/account"
                    className="btn btn-sm btn-outline-primary"
                    onClick={closeMenu}
                  >
                    {session.user.displayName}
                  </NavLink>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary theme-button"
                    onClick={() => void handleSignOut()}
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <NavLink to="/login" className="btn btn-sm btn-primary" onClick={closeMenu}>
                  Sign in
                </NavLink>
              )}
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
