import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth';
import { ADMIN_PATH, CATALOG_PATH, globalAreaOf } from '../navigation';
import { ApiStatusBadge } from './ApiStatusBadge';
import { BrandLogo } from './Brand';
import { ThemeButton } from './ThemeButton';

/**
 * A global area is active anywhere inside it, which a link's own path matching cannot tell: a VM's management is
 * under /admin, yet it is part of the catalog. So these are plain links, marked from {@link globalAreaOf}.
 */
const areaLinkClass = (active: boolean) => `nav-link${active ? ' active' : ''}`;

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  const { state, signOut } = useAuth();
  const navigate = useNavigate();
  const area = globalAreaOf(useLocation().pathname);
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
      <nav className="navbar navbar-expand-lg border-bottom bg-body-tertiary">
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
                <Link
                  to={CATALOG_PATH}
                  className={areaLinkClass(area === 'catalog')}
                  aria-current={area === 'catalog' ? 'page' : undefined}
                  onClick={closeMenu}
                >
                  Catalog
                </Link>
              </li>
              {isAdmin ? (
                <li className="nav-item">
                  <Link
                    to={ADMIN_PATH}
                    className={areaLinkClass(area === 'admin')}
                    aria-current={area === 'admin' ? 'page' : undefined}
                    onClick={closeMenu}
                  >
                    Admin
                  </Link>
                </li>
              ) : null}
            </ul>
            <div className="d-flex flex-wrap align-items-center gap-3 py-2 py-lg-0">
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
