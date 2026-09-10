import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { describeError } from '../api/client';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (updater: T | ((prev: T | null) => T | null)) => void;
}

/** Runs an async loader on mount / when deps change; ignores stale results. */
export function useAsync<T>(loader: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    loader().then(
      (result) => {
        if (my !== seq.current) return;
        setData(result);
        setLoading(false);
      },
      (err) => {
        if (my !== seq.current) return;
        setError(describeError(err));
        setLoading(false);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}
