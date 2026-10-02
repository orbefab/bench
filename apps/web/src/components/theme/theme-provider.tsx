import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AppearancePrefsProvider } from "@/components/theme/appearance-prefs";
import {
  type Appearance,
  bindThemeApplier,
  STUDIO_HEX,
} from "@/lib/appearance";
import { desktopBridge } from "@/lib/desktop";
import { xrUiStore } from "@/state/xr";

const STORAGE_KEY = "sfab-bench.theme";

export type ThemePreference = "light" | "dark" | "system";

type ThemeContextValue = {
  theme: ThemePreference;
  resolvedTheme: Appearance;
  setTheme: (next: string) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemePreference(
  value: string | null | undefined
): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isThemePreference(stored)) return stored;
  } catch {
    /* private mode */
  }
  return "system";
}

function systemAppearance(): Appearance {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyAppearance(resolved: Appearance) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

function disableTransitionsThen(apply: () => void) {
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(style);
  apply();
  window.getComputedStyle(document.body);
  requestAnimationFrame(() => {
    style.remove();
  });
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(() =>
    typeof window === "undefined" ? "system" : readStoredTheme()
  );
  const [system, setSystem] = useState<Appearance>(() =>
    typeof window === "undefined" ? "light" : systemAppearance()
  );
  const resolvedTheme: Appearance = theme === "system" ? system : theme;
  const lastResolved = useRef<Appearance | null>(null);

  const setTheme = useCallback((next: string) => {
    if (!isThemePreference(next)) return;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode */
    }
    setThemeState(next);
  }, []);

  useEffect(() => {
    const paint = () => {
      applyAppearance(resolvedTheme);
      xrUiStore.getState().setAppearance(resolvedTheme);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", STUDIO_HEX[resolvedTheme]);
      desktopBridge()?.setTheme?.(theme);
    };
    if (lastResolved.current === resolvedTheme) {
      desktopBridge()?.setTheme?.(theme);
      return;
    }
    const skipTransition = lastResolved.current !== null;
    lastResolved.current = resolvedTheme;
    if (skipTransition) disableTransitionsThen(paint);
    else paint();
  }, [theme, resolvedTheme]);

  useEffect(() => {
    bindThemeApplier((next: Appearance) => setTheme(next));
    return () => bindThemeApplier(null);
  }, [setTheme]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setThemeState(
        isThemePreference(event.newValue) ? event.newValue : "system"
      );
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  );

  return (
    <ThemeContext.Provider value={value}>
      <AppearancePrefsProvider>{children}</AppearancePrefsProvider>
    </ThemeContext.Provider>
  );
}
