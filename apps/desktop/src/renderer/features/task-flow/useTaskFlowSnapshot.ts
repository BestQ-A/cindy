import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskFlowSnapshot } from '../../../shared/taskFlowGraph';

export interface UseTaskFlowSnapshotResult {
  snapshot: TaskFlowSnapshot | null;
  loading: boolean;
  error: string | null;
  nowMs: number;
  refresh: () => Promise<void>;
}

const EMPTY_SNAPSHOT: TaskFlowSnapshot = {
  nodes: [],
  edges: [],
  selfDeviceId: null,
  selfDeviceName: null,
  observedAt: 0,
  hiddenScheduledCount: 0,
};

export function useTaskFlowSnapshot(includeScheduled: boolean): UseTaskFlowSnapshotResult {
  const [snapshot, setSnapshot] = useState<TaskFlowSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const debounceTimerRef = useRef<number | null>(null);

  const fetchSnapshot = useCallback(
    async (silent = false) => {
      const api = window.electronAPI?.localDb?.taskFlow?.snapshot;
      if (typeof api !== 'function') {
        setSnapshot((prev) => prev ?? EMPTY_SNAPSHOT);
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const result = await api({ includeScheduled, includeRemote: true });
        setSnapshot(result ?? EMPTY_SNAPSHOT);
        setError(null);
        setNowMs(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [includeScheduled],
  );

  useEffect(() => {
    void fetchSnapshot(false);
  }, [fetchSnapshot]);

  // Listen to hierarchy and subagent run updates with a short debounce.
  useEffect(() => {
    const scheduleRefresh = () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        void fetchSnapshot(true);
      }, 350);
    };

    const unsubs: Array<() => void> = [];
    const onSubagentChanged = window.electronAPI?.localDb?.subagentRuns?.onChanged;
    if (typeof onSubagentChanged === 'function') {
      unsubs.push(onSubagentChanged(scheduleRefresh));
    }
    const onHierarchyChanged = window.electronAPI?.localDb?.bots?.hierarchy?.onChanged;
    if (typeof onHierarchyChanged === 'function') {
      unsubs.push(onHierarchyChanged(scheduleRefresh));
    }
    const onTaskTagsChanged = window.electronAPI?.localDb?.taskTags?.onChanged;
    if (typeof onTaskTagsChanged === 'function') {
      unsubs.push(onTaskTagsChanged(scheduleRefresh));
    }

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // ignore cleanup failures
        }
      }
    };
  }, [fetchSnapshot]);

  // Background refresh every 8s while visible so timeline & handoffs stay fresh.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void fetchSnapshot(true);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [fetchSnapshot]);

  const hasRunning = Boolean(snapshot?.nodes.some((n) => n.status === 'running'));
  useEffect(() => {
    if (!hasRunning) return;
    const tick = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [hasRunning]);

  const refresh = useCallback(() => fetchSnapshot(false), [fetchSnapshot]);

  return {
    snapshot,
    loading,
    error,
    nowMs,
    refresh,
  };
}
