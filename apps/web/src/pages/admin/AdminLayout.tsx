import { matchPath, Outlet, useLocation } from 'react-router';
import { SidebarLayout } from '../../components/SidebarLayout';
import { ADMIN_NAV_ITEMS } from '../../navigation';

/** The Admin area: its sidebar, and the page chosen in it. Must be inside the administrator guard. */
export function AdminLayout() {
  const { pathname } = useLocation();
  const current = ADMIN_NAV_ITEMS.find((item) =>
    matchPath({ path: item.to, end: item.end ?? false }, pathname),
  );
  return (
    <SidebarLayout
      id="admin-sidebar"
      label="Admin"
      items={ADMIN_NAV_ITEMS}
      currentLabel={current?.label}
    >
      <Outlet />
    </SidebarLayout>
  );
}
