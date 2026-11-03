"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "glaramara:system-view";

type SystemViewContextValue = {
  enabled: boolean;
  ready: boolean;
  setEnabled: (enabled: boolean) => void;
};

const SystemViewContext = createContext<SystemViewContextValue | null>(null);

export function SystemViewProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabledState] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setEnabledState(window.sessionStorage.getItem(STORAGE_KEY) === "on");
    setReady(true);
  }, []);

  const value = useMemo(() => ({
    enabled,
    ready,
    setEnabled(next: boolean) {
      setEnabledState(next);
      window.sessionStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    },
  }), [enabled, ready]);

  return <SystemViewContext.Provider value={value}>{children}</SystemViewContext.Provider>;
}

export function useSystemView() {
  const value = useContext(SystemViewContext);
  if (!value) throw new Error("useSystemView must be used inside SystemViewProvider");
  return value;
}
