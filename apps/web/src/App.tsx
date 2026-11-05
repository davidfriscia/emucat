import { Route, Routes } from 'react-router';
import { AuthProvider } from './auth';
import { RequireAdmin, RequireSession } from './components/Guards';
import { Layout } from './components/Layout';
import { AccountPage } from './pages/AccountPage';
import { AgentDetailPage } from './pages/admin/AgentDetailPage';
import { AgentsPage } from './pages/admin/AgentsPage';
import { CatalogManagementPage } from './pages/admin/CatalogManagementPage';
import { DashboardPage } from './pages/admin/DashboardPage';
import { RepositoriesPage } from './pages/admin/RepositoriesPage';
import { VmEditorPage } from './pages/admin/VmEditorPage';
import { VmMediaPage } from './pages/admin/VmMediaPage';
import { CatalogPage } from './pages/CatalogPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SettingsPage } from './pages/SettingsPage';
import { SetupPage } from './pages/SetupPage';
import { VmDetailPage } from './pages/VmDetailPage';
import { ThemeProvider } from './theme';

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
                <Route index element={<DashboardPage />} />
                <Route path="catalog" element={<CatalogManagementPage />} />
                <Route path="agents" element={<AgentsPage />} />
                <Route path="agents/:agentId" element={<AgentDetailPage />} />
                <Route path="repositories" element={<RepositoriesPage />} />
                <Route path="vms/:emulatorType/:vmName" element={<VmEditorPage />} />
                <Route path="vms/:emulatorType/:vmName/media" element={<VmMediaPage />} />
              </Route>
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </ThemeProvider>
  );
}
