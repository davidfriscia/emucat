import { Navigate } from 'react-router';
import { useAuth } from '../auth';
import { ServerInfoCard, ThemeSettingsCard } from '../components/SettingsCards';

/**
 * Settings of a signed-in user who is not an administrator: the theme, and what the server runs. An administrator
 * finds the same under Admin, in Appearance and Application Updates, so an old link to this page leads there.
 */
export function SettingsPage() {
  const { state } = useAuth();
  if (state.status === 'authenticated' && state.session.user.role === 'admin') {
    return <Navigate to="/admin/appearance" replace />;
  }
  return (
    <>
      <title>Settings · EmuCat</title>
      <h1 className="h3 mb-4">Settings</h1>
      <div className="settings-grid">
        <ThemeSettingsCard />
        <ServerInfoCard />
      </div>
    </>
  );
}
