"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "x-sweeper.settings";
const DEFAULT_SETTINGS = { autoUnfollow: false, sweepCount: 3 };
const ALLOWED_SWEEP_COUNTS = new Set([3, 10, 20, 30, 50, 100, 200, 500]);

const SweepSettingsContext = createContext(null);

function normalizeSettings(value) {
  return {
    autoUnfollow: value?.autoUnfollow === true,
    sweepCount: ALLOWED_SWEEP_COUNTS.has(Number(value?.sweepCount))
      ? Number(value.sweepCount)
      : DEFAULT_SETTINGS.sweepCount,
  };
}

export default function SweepSettingsProvider({ children }) {
  const [state, setState] = useState({ settings: DEFAULT_SETTINGS, ready: false });

  useEffect(() => {
    let settings = DEFAULT_SETTINGS;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) settings = normalizeSettings(JSON.parse(stored));
    } catch {
      // Browser storage can be unavailable; the safe defaults still work.
    }
    // Hydrate browser-only settings after the server render to avoid a markup mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ settings, ready: true });
  }, []);

  const updateSettings = (updates) => {
    setState((current) => {
      const settings = normalizeSettings({ ...current.settings, ...updates });
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // Keep the in-memory setting when persistence is unavailable.
      }
      return { settings, ready: true };
    });
  };

  const value = useMemo(
    () => ({ ...state.settings, ready: state.ready, updateSettings }),
    [state],
  );

  return (
    <SweepSettingsContext.Provider value={value}>
      {children}
    </SweepSettingsContext.Provider>
  );
}

export function useSweepSettings() {
  const context = useContext(SweepSettingsContext);
  if (!context) throw new Error("useSweepSettings must be used inside SweepSettingsProvider");
  return context;
}
