import { Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthProvider } from './auth';
import { RequireAdmin, RequireSession } from './components/Guards';
import { Layout } from './components/Layout';
import { ADMIN_HOME, VM_SECTIONS } from './navigation';
import { AccountPage } from './pages/AccountPage';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AgentDetailPage } from './pages/admin/AgentDetailPage';
import { AgentsPage } from './pages/admin/AgentsPage';
import { AppearancePage } from './pages/admin/AppearancePage';
import { ApplicationUpdatesPage } from './pages/admin/ApplicationUpdatesPage';
import { RegistrationsPage } from './pages/admin/RegistrationsPage';
import { RepositoriesPage } from './pages/admin/RepositoriesPage';
import { VmCopiesPage } from './pages/admin/vm/VmCopiesPage';
import { VmGeneralPage } from './pages/admin/vm/VmGeneralPage';
import { VmManageLayout } from './pages/admin/vm/VmManageLayout';
import { VmNotesPage } from './pages/admin/vm/VmNotesPage';
import { VmScreenshotsPage } from './pages/admin/vm/VmScreenshotsPage';
import { VmVersionsPage } from './pages/admin/vm/VmVersionsPage';
import { CatalogPage } from './pages/CatalogPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SettingsPage } from './pages/SettingsPage';
import { SetupPage } from './pages/SetupPage';
import { VmDetailPage } from './pages/VmDetailPage';
import { ThemeProvider } from './theme';

/** The old catalog management page is the catalog now: its filters, visibility included, still apply. */
function ToCatalog() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/', search }} replace />;
}

/**
 * Every route (docs/architecture.md, "Navigation"). Guards decide who may see a page here; the API decides it for
 * every request regardless.
 */
export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<CatalogPage />} />
            <Route path="vms/:emulatorType/:vmName" element={<VmDetailPage />} />
            <Route path="login" element={<LoginPage />} />
            <Route path="setup" element={<SetupPage />} />
            <Route element={<RequireSession />}>
              <Route path="account" element={<AccountPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="admin" element={<RequireAdmin />}>
                <Route element={<AdminLayout />}>
                  <Route index element={<Navigate to={ADMIN_HOME} replace />} />
                  <Route path="agents" element={<AgentsPage />} />
                  <Route path="agents/:agentId" element={<AgentDetailPage />} />
                  <Route path="registrations" element={<RegistrationsPage />} />
                  <Route path="repositories" element={<RepositoriesPage />} />
                  <Route path="appearance" element={<AppearancePage />} />
                  <Route path="updates" element={<ApplicationUpdatesPage />} />
                </Route>
                <Route path="catalog" element={<ToCatalog />} />
                <Route path="vms/:emulatorType/:vmName" element={<VmManageLayout />}>
                  <Route index element={<VmGeneralPage />} />
                  <Route path={VM_SECTIONS.versions} element={<VmVersionsPage />} />
                  <Route path={VM_SECTIONS.copies} element={<VmCopiesPage />} />
                  <Route path={VM_SECTIONS.notes} element={<VmNotesPage />} />
                  <Route path={VM_SECTIONS.screenshots} element={<VmScreenshotsPage />} />
                  {/* The media page of earlier releases. */}
                  <Route
                    path="media"
                    element={
                      <Navigate to={`../${VM_SECTIONS.screenshots}`} relative="path" replace />
                    }
                  />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Route>
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </ThemeProvider>
  );
}
