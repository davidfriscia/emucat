import { THEME_PREFERENCES, useTheme } from '../theme';

const LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' } as const;

/** Cycles through the theme preferences. The label names the current one. */
export function ThemeButton() {
  const { preference, setPreference } = useTheme();
  const next =
    THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(preference) + 1) % THEME_PREFERENCES.length] ??
    'auto';
  return (
    <button
      type="button"
      className="btn btn-sm btn-outline-secondary theme-button"
      onClick={() => setPreference(next)}
      aria-label={`Theme: ${LABELS[preference]}. Switch to ${LABELS[next]}.`}
    >
      Theme: {LABELS[preference]}
    </button>
  );
}
