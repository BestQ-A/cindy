import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  computeGoalNextActions,
  createEmptyGoalBoardConfig,
  type GoalBoardConfigV1,
  type GoalItemTransitionInput,
  type GoalNextActionsSummary,
  type GoalRecord,
} from '../../../shared/goalBoard';

export interface UseGoalBoardResult {
  config: GoalBoardConfigV1;
  activeGoal: GoalRecord | null;
  nextActions: GoalNextActionsSummary | null;
  loading: boolean;
  error: string | null;
  selectedGoalId: string | null;
  selectGoalId: (goalId: string) => void;
  refreshGoalBoard: () => Promise<void>;
  transitionItem: (
    input: { goalId: string } & GoalItemTransitionInput,
  ) => Promise<{ ok: boolean; message?: string }>;
}

export function useGoalBoard(): UseGoalBoardResult {
  const [config, setConfig] = useState<GoalBoardConfigV1>(() => createEmptyGoalBoardConfig());
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBoard = useCallback(async (silent = false) => {
    const getApi = window.electronAPI?.localDb?.goalBoard?.get;
    if (typeof getApi !== 'function') {
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const snapshot = await getApi();
      if (snapshot?.config) {
        setConfig(snapshot.config);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBoard(false);
  }, [fetchBoard]);

  useEffect(() => {
    const onChanged = window.electronAPI?.localDb?.goalBoard?.onChanged;
    if (typeof onChanged !== 'function') return;
    return onChanged((snapshot) => {
      if (snapshot?.config) {
        setConfig(snapshot.config);
        setError(null);
      }
    });
  }, []);

  const activeGoal = useMemo(() => {
    if (config.goals.length === 0) return null;
    if (selectedGoalId) {
      const matched = config.goals.find((g) => g.id === selectedGoalId);
      if (matched) return matched;
    }
    return config.goals.find((g) => g.status === 'active') ?? config.goals[0] ?? null;
  }, [config.goals, selectedGoalId]);

  const nextActions = useMemo(
    () => (activeGoal ? computeGoalNextActions(activeGoal) : null),
    [activeGoal],
  );

  const refreshGoalBoard = useCallback(async () => {
    await fetchBoard(false);
  }, [fetchBoard]);

  const transitionItem = useCallback(
    async (input: { goalId: string } & GoalItemTransitionInput): Promise<{ ok: boolean; message?: string }> => {
      const api = window.electronAPI?.localDb?.goalBoard?.transitionItem;
      if (typeof api !== 'function') {
        return { ok: false, message: 'Goal board IPC unavailable' };
      }
      try {
        const res = await api(input);
        if (res.ok) {
          setConfig(res.config);
          setError(null);
          return { ok: true };
        }
        setError(res.message);
        return { ok: false, message: res.message };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return { ok: false, message: msg };
      }
    },
    [],
  );

  return {
    config,
    activeGoal,
    nextActions,
    loading,
    error,
    selectedGoalId,
    selectGoalId: setSelectedGoalId,
    refreshGoalBoard,
    transitionItem,
  };
}
