import { useEffect, useState } from 'react';
import type { InfoResponse } from '@emucat/contracts';
import { fetchApiInfo } from '../api';
import { THEME_PREFERENCES, useTheme, type ThemePreference } from '../theme';

const THEME_LABELS: Record<ThemePreference, string> = {
  auto: 'Match system',
  light: 'Light',
  dark: 'Dark',
};

/** The theme of this browser. It is kept in this browser only, so every user chooses their own. */
export function ThemeSettingsCard() {
  const { preference, setPreference } = useTheme();
  return (
    <section className="card" aria-labelledby="theme-settings-heading">
      <div className="card-body">
        <h2 id="theme-settings-heading" className="h6 card-title">
          Theme
        </h2>
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
        <p className="small text-body-secondary mb-0 mt-2">
          Saved in this browser. The button in the header switches it too.
        </p>
      </div>
    </section>
  );
}

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

/** The versions the server reports about itself. */
export function ServerInfoCard() {
  const info = useApiInfo();
  return (
    <section className="card" aria-labelledby="server-info-heading">
      <div className="card-body">
        <h2 id="server-info-heading" className="h6 card-title">
          Server
        </h2>
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
  );
}
