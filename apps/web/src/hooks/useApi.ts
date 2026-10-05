import { useCallback, useEffect, useState } from 'react';

export function useAsyncData<T>(loader: () => Promise<T>, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const next = await loader();
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [loader]);

  useEffect(() => {
    setLoading(true);
    void reload();
    if (!refreshMs) return undefined;
    const timer = window.setInterval(() => {
      void reload();
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [reload, refreshMs]);

  return { data, error, loading, reload };
}
