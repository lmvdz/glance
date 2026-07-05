import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = 'omp.theme';

/**
 * Resolve the startup theme: a previously-saved explicit choice wins, else the OS preference, else the
 * app's dark default. Pure + exported so the precedence is unit-tested. `stored` is the raw localStorage
 * value (may be null / garbage); `prefersLight` is `matchMedia('(prefers-color-scheme: light)').matches`.
 */
export function initialTheme(stored: string | null, prefersLight: boolean): Theme {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersLight ? 'light' : 'dark';
}

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    return initialTheme(window.localStorage.getItem(STORAGE_KEY), window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false);
  } catch {
    return 'dark'; // localStorage / matchMedia unavailable (private mode, etc.)
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    // Persist the choice so it survives a reload — the toggle was previously in-session only.
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // storage unavailable — the in-session toggle still works, just isn't remembered
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
}
