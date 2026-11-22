import { ThemeSettingsCard } from '../../components/SettingsCards';

/** How the application looks in this browser. */
export function AppearancePage() {
  return (
    <>
      <title>Appearance · Admin · EmuCat</title>
      <h1 className="h3 mb-4">Appearance</h1>
      <div className="settings-grid">
        <ThemeSettingsCard />
      </div>
    </>
  );
}
