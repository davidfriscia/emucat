import { useEffect, useState } from 'react';
import type { InfoResponse } from '@emucat/contracts';
import { fetchApiInfo } from '../api';
import { THEME_PREFERENCES, useTheme, type ThemePreference } from '../theme';

const THEME_LABELS: Record<ThemePreference, string> = {
  auto: 'Match system',
  light: 'Light',
  dark: 'Dark',
};

function useApiInfo(): InfoResponse | null {
  const [info, setInfo] = useState<InfoResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchApiInfo(controller.signal).then((next) => {
      if (!controller.signal.aborted) setInfo(next);
    });
    return () => controller.abort();
  }, []);
  return info;
}

export function SettingsPage() {
  const { preference, setPreference } = useTheme();
  const info = useApiInfo();

  return (
    <>
      <h1 className="h3 mb-4">Settings</h1>
      <div className="settings-grid">
        <section className="card">
          <div className="card-body">
            <h2 className="h6 card-title">Appearance</h2>
            <fieldset>
              <legend className="visually-hidden">Theme</legend>
              {THEME_PREFERENCES.map((theme) => (
                <div className="form-check" key={theme}>
                  <input
                    className="form-check-input"
                    type="radio"
                    name="theme"
                    id={`theme-${theme}`}
                    checked={preference === theme}
                    onChange={() => setPreference(theme)}
                  />
                  <label className="form-check-label" htmlFor={`theme-${theme}`}>
                    {THEME_LABELS[theme]}
                  </label>
                </div>
              ))}
            </fieldset>
          </div>
        </section>
        <section className="card">
          <div className="card-body">
            <h2 className="h6 card-title">Server</h2>
            {info ? (
              <dl className="mb-0 small settings-facts">
                <dt>Version</dt>
                <dd>{info.version}</dd>
                <dt>API</dt>
                <dd>{info.apiVersion}</dd>
                <dt>Agent protocol</dt>
                <dd>{info.protocolVersion}</dd>
              </dl>
            ) : (
              <p className="small text-body-secondary mb-0">Server information is unavailable.</p>
            )}
          </div>
        </section>
      </div>
      <p className="text-body-secondary small mt-4">
        Agent, emulator and repository settings are planned for a future version.
      </p>
    </>
  );
}
