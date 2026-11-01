"use client";

import { useCallback, useEffect, useState } from "react";

import { bankingFetch } from "@/lib/banking-api";

export function useBankingResource<T>(path: string, dependency?: string, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!enabled) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      setData(await bankingFetch<T>(path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The fictional banking service is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [path, dependency, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load };
}
