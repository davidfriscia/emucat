import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export const THEME_PREFERENCES = ['auto', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

const STORAGE_KEY = 'emucat.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return THEME_PREFERENCES.find((theme) => theme === stored) ?? 'auto';
  } catch {
    return 'auto';
  }
}

function savePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // The choice still applies for this visit.
  }
}

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readPreference);

  useEffect(() => {
    const media = matchMedia(DARK_QUERY);
    const apply = () => {
      const theme = preference === 'auto' ? (media.matches ? 'dark' : 'light') : preference;
      document.documentElement.setAttribute('data-bs-theme', theme);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);

  const value = useMemo(
    () => ({
      preference,
      setPreference: (next: ThemePreference) => {
        savePreference(next);
        setPreferenceState(next);
      },
    }),
    [preference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
