import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';

import {
  applyGoalItemTransition,
  createEmptyGoalBoardConfig,
  normalizeGoalBoardConfig,
  normalizeGoalRecord,
  recomputeGoalGraph,
  type GoalBoardConfigV1,
  type GoalItemTransitionInput,
  type GoalRecord,
  type GoalStatus,
  type GoalWorkItem,
  type GoalWorkItemStatus,
} from '../../shared/goalBoard.js';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  onAppSessionInvalidated,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
} from '../device-link/broadcast-tap.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { createLogger } from '../logger.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsFile,
} from '../maker-host/override-settings-file.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';

const log = createLogger('maker-ipc:goal-board');

export const GOAL_BOARD_CHANGED_CHANNEL = 'local-db:goal-board:changed' as const;
const GOAL_BOARD_FILE_NAME = 'goal-board.v1.json';
const GOAL_BOARD_MAX_BYTES = 2 * 1024 * 1024;

export interface GoalBoardSnapshot {
  ownerId: string | null;
  config: GoalBoardConfigV1;
}

export interface GoalUpsertItemInput {
  id: string;
  title: string;
  status?: GoalWorkItemStatus;
  blockedBy?: string[];
  ownerRole?: string;
  ownerBotId?: string;
  ownerSessionId?: string;
  backupOwnerRole?: string;
  backupOwnerBotId?: string;
  reviewerRole?: string;
  reviewerBotId?: string;
  reviewerSessionId?: string;
  artifactPaths?: string[];
  acceptanceCriteria?: string;
  evidenceSummary?: string;
  blockerReason?: string;
}

export interface GoalUpsertInput {
  id?: string;
  title: string;
  objective?: string;
  projectPath?: string;
  pmRole?: string;
  pmBotId?: string;
  pmSessionId?: string;
  status?: GoalStatus;
  exitCriteria?: string[];
  items?: GoalUpsertItemInput[];
}

export type GoalBoardTransitionStoreResult =
  | {
      ok: true;
      config: GoalBoardConfigV1;
      goal: GoalRecord;
      item: GoalWorkItem;
      newlyUnlockedIds: string[];
    }
  | {
      ok: false;
      errorCode: 'GOAL_NOT_FOUND' | 'ITEM_NOT_FOUND' | 'WAVE_GATE_BLOCKED' | 'REVIEW_REQUIRED';
      message: string;
    };

let storeFile: OverrideSettingsFile<GoalBoardConfigV1> | null = null;
let storeFilePathCache: string | null = null;
let ipcRegistered = false;
let localWriteChain: Promise<unknown> = Promise.resolve();
let sessionInvalidationUnsub: (() => void) | null = null;

function ensureSessionInvalidationHook(): void {
  if (sessionInvalidationUnsub) return;
  try {
    sessionInvalidationUnsub = onAppSessionInvalidated(() => {
      storeFile = null;
      storeFilePathCache = null;
    });
  } catch {
    // Electron/app storage may not be initialized in minimal unit tests.
  }
}

function getSafeScopeKey(): string {
  try {
    return activeOwnerScopeKey();
  } catch {
    return 'default';
  }
}

function resolveGoalBoardFilePath(): string {
  return ownerScopedUserDataPath(GOAL_BOARD_FILE_NAME);
}

function getStoreFile(): OverrideSettingsFile<GoalBoardConfigV1> {
  ensureSessionInvalidationHook();
  const currentPath = resolveGoalBoardFilePath();
  if (!storeFile || storeFilePathCache !== currentPath) {
    storeFilePathCache = currentPath;
    storeFile = createOverrideSettingsFile<GoalBoardConfigV1>({
      filePath: resolveGoalBoardFilePath,
      defaults: () => createEmptyGoalBoardConfig(),
      normalize: (raw) => normalizeGoalBoardConfig(raw),
      mergeOverrides: ({ next }) => ({ ...next }) as unknown as Record<string, unknown>,
      log,
      label: 'goal-board',
      scopeKey: getSafeScopeKey,
      maxBytes: GOAL_BOARD_MAX_BYTES,
      preserveUnreadableFile: true,
      logLoadedValue: false,
      logReadErrorDetails: true,
    });
  }
  return storeFile;
}

function getSafeOwnerId(): string | null {
  try {
    if (isAppSessionBoundaryPending()) return null;
    return getActiveAppSession().dataOwnerId;
  } catch {
    return null;
  }
}

function withLocalWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = localWriteChain.then(task, task);
  localWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function emitGoalBoardChanged(
  snapshot: GoalBoardSnapshot,
  ownerStamp?: DataOwnerPushStamp,
): void {
  let windows: BrowserWindow[] = [];
  try {
    windows = BrowserWindow?.getAllWindows?.() ?? [];
  } catch {
    windows = [];
  }
  for (const win of windows) {
    try {
      if (win.isDestroyed()) continue;
      if (ownerStamp === undefined) {
        win.webContents.send(GOAL_BOARD_CHANGED_CHANNEL, snapshot);
      } else {
        win.webContents.send(GOAL_BOARD_CHANGED_CHANNEL, snapshot, ownerStamp);
      }
    } catch {
      // Ignore closed/destroyed window send failure.
    }
  }
  try {
    tapWindowBroadcast(GOAL_BOARD_CHANGED_CHANNEL, snapshot, ownerStamp);
  } catch {
    // Device-link tap is optional in isolated unit tests.
  }
}

export function readGoalBoard(): GoalBoardConfigV1 {
  const file = getStoreFile();
  file.invalidateIfChanged();
  return normalizeGoalBoardConfig(file.read());
}

export function readGoalBoardSnapshot(): GoalBoardSnapshot {
  return {
    ownerId: getSafeOwnerId(),
    config: readGoalBoard(),
  };
}

export async function upsertGoalRecord(
  input: GoalUpsertInput,
  nowMs = Date.now(),
): Promise<{ config: GoalBoardConfigV1; goal: GoalRecord }> {
  const scope = captureDataOwnerBroadcastScope();
  const goalId = input.id?.trim() || `goal-${randomUUID().slice(0, 8)}`;

  const saved = await withLocalWriteLock(async () => {
    const file = getStoreFile();
    file.invalidateIfChanged();

    let resultingGoal: GoalRecord | null = null;
    const nextConfig = await file.updateAtomic(
      (state) => {
        const current = normalizeGoalBoardConfig(state.value);
        const existingGoal = current.goals.find((g) => g.id === goalId);
        const existingItemsById = new Map((existingGoal?.items ?? []).map((item) => [item.id, item]));

        const mergedItems: GoalWorkItem[] =
          input.items !== undefined
            ? input.items.map((incoming) => {
                const prev = existingItemsById.get(incoming.id.trim());
                return {
                  ...(prev ?? {}),
                  id: incoming.id.trim(),
                  title: incoming.title,
                  status: incoming.status ?? prev?.status ?? 'pending',
                  blockedBy: incoming.blockedBy ?? prev?.blockedBy ?? [],
                  ...(incoming.ownerRole !== undefined
                    ? { ownerRole: incoming.ownerRole }
                    : prev?.ownerRole
                      ? { ownerRole: prev.ownerRole }
                      : {}),
                  ...(incoming.ownerBotId !== undefined
                    ? { ownerBotId: incoming.ownerBotId }
                    : prev?.ownerBotId
                      ? { ownerBotId: prev.ownerBotId }
                      : {}),
                  ...(incoming.ownerSessionId !== undefined
                    ? { ownerSessionId: incoming.ownerSessionId }
                    : prev?.ownerSessionId
                      ? { ownerSessionId: prev.ownerSessionId }
                      : {}),
                  ...(incoming.backupOwnerRole !== undefined
                    ? { backupOwnerRole: incoming.backupOwnerRole }
                    : prev?.backupOwnerRole
                      ? { backupOwnerRole: prev.backupOwnerRole }
                      : {}),
                  ...(incoming.backupOwnerBotId !== undefined
                    ? { backupOwnerBotId: incoming.backupOwnerBotId }
                    : prev?.backupOwnerBotId
                      ? { backupOwnerBotId: prev.backupOwnerBotId }
                      : {}),
                  ...(incoming.reviewerRole !== undefined
                    ? { reviewerRole: incoming.reviewerRole }
                    : prev?.reviewerRole
                      ? { reviewerRole: prev.reviewerRole }
                      : {}),
                  ...(incoming.reviewerBotId !== undefined
                    ? { reviewerBotId: incoming.reviewerBotId }
                    : prev?.reviewerBotId
                      ? { reviewerBotId: prev.reviewerBotId }
                      : {}),
                  ...(incoming.reviewerSessionId !== undefined
                    ? { reviewerSessionId: incoming.reviewerSessionId }
                    : prev?.reviewerSessionId
                      ? { reviewerSessionId: prev.reviewerSessionId }
                      : {}),
                  artifactPaths: incoming.artifactPaths ?? prev?.artifactPaths ?? [],
                  ...(incoming.acceptanceCriteria !== undefined
                    ? { acceptanceCriteria: incoming.acceptanceCriteria }
                    : prev?.acceptanceCriteria
                      ? { acceptanceCriteria: prev.acceptanceCriteria }
                      : {}),
                  ...(incoming.evidenceSummary !== undefined
                    ? { evidenceSummary: incoming.evidenceSummary }
                    : prev?.evidenceSummary
                      ? { evidenceSummary: prev.evidenceSummary }
                      : {}),
                  ...(incoming.blockerReason !== undefined
                    ? { blockerReason: incoming.blockerReason }
                    : prev?.blockerReason
                      ? { blockerReason: prev.blockerReason }
                      : {}),
                  updatedAtMs: nowMs,
                };
              })
            : existingGoal?.items ?? [];

        const normalizedGoal = normalizeGoalRecord(
          {
            ...(existingGoal ?? {}),
            id: goalId,
            title: input.title || existingGoal?.title || goalId,
            objective: input.objective ?? existingGoal?.objective ?? input.title,
            projectPath: input.projectPath ?? existingGoal?.projectPath,
            pmRole: input.pmRole ?? existingGoal?.pmRole,
            pmBotId: input.pmBotId ?? existingGoal?.pmBotId,
            pmSessionId: input.pmSessionId ?? existingGoal?.pmSessionId,
            status: input.status ?? existingGoal?.status ?? 'active',
            exitCriteria: input.exitCriteria ?? existingGoal?.exitCriteria ?? [],
            items: mergedItems,
            createdAtMs: existingGoal?.createdAtMs ?? nowMs,
            updatedAtMs: nowMs,
          },
          nowMs,
        );

        resultingGoal = normalizedGoal ?? recomputeGoalGraph({
          id: goalId,
          title: input.title,
          objective: input.objective ?? input.title,
          status: input.status ?? 'active',
          exitCriteria: input.exitCriteria ?? [],
          items: [],
          createdAtMs: existingGoal?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
        });

        const nextGoals = existingGoal
          ? current.goals.map((g) => (g.id === goalId ? resultingGoal! : g))
          : [resultingGoal, ...current.goals];

        return {
          version: 1,
          updatedAtMs: nowMs,
          goals: nextGoals,
        } satisfies GoalBoardConfigV1;
      },
      { preserveDefaults: true },
    );

    const normalizedNext = normalizeGoalBoardConfig(nextConfig);
    return {
      config: normalizedNext,
      goal: normalizedNext.goals.find((g) => g.id === goalId) ?? resultingGoal!,
    };
  });

  if (isDataOwnerBroadcastScopeCurrent(scope)) {
    emitGoalBoardChanged(
      { ownerId: getSafeOwnerId(), config: saved.config },
      scope.ownerStamp,
    );
  }
  return saved;
}

export async function transitionGoalWorkItem(
  input: { goalId: string } & GoalItemTransitionInput,
  nowMs = Date.now(),
): Promise<GoalBoardTransitionStoreResult> {
  const scope = captureDataOwnerBroadcastScope();

  const outcome = await withLocalWriteLock(async (): Promise<GoalBoardTransitionStoreResult> => {
    const file = getStoreFile();
    file.invalidateIfChanged();
    const current = normalizeGoalBoardConfig(file.read());
    const targetGoal = current.goals.find((g) => g.id === input.goalId);
    if (!targetGoal) {
      return {
        ok: false,
        errorCode: 'GOAL_NOT_FOUND',
        message: `目标 ${input.goalId} 不存在，请先用 goal_board_get 核对 goal_id。`,
      };
    }

    const preview = applyGoalItemTransition(targetGoal, input, nowMs);
    if (!preview.ok) {
      return preview;
    }

    const transitionBox: {
      value: Extract<GoalBoardTransitionStoreResult, { ok: true }> | null;
    } = { value: null };
    const nextConfig = await file.updateAtomic(
      (state) => {
        const fresh = normalizeGoalBoardConfig(state.value);
        const freshGoal = fresh.goals.find((g) => g.id === input.goalId);
        if (!freshGoal) return fresh;
        const applied = applyGoalItemTransition(freshGoal, input, nowMs);
        if (!applied.ok) return fresh;
        transitionBox.value = {
          ok: true,
          config: fresh,
          goal: applied.goal,
          item: applied.item,
          newlyUnlockedIds: applied.newlyUnlockedIds,
        };
        return {
          version: 1,
          updatedAtMs: nowMs,
          goals: fresh.goals.map((g) => (g.id === input.goalId ? applied.goal : g)),
        } satisfies GoalBoardConfigV1;
      },
      { preserveDefaults: true },
    );

    const normalizedNext = normalizeGoalBoardConfig(nextConfig);
    const committed = transitionBox.value;
    if (!committed) {
      return {
        ok: false,
        errorCode: 'GOAL_NOT_FOUND',
        message: `目标 ${input.goalId} 状态发生变化，请重试。`,
      };
    }
    return {
      ok: true,
      config: normalizedNext,
      goal: normalizedNext.goals.find((g) => g.id === input.goalId) ?? committed.goal,
      item: committed.item,
      newlyUnlockedIds: committed.newlyUnlockedIds,
    };
  });

  if (outcome.ok && isDataOwnerBroadcastScopeCurrent(scope)) {
    emitGoalBoardChanged(
      { ownerId: getSafeOwnerId(), config: outcome.config },
      scope.ownerStamp,
    );
  }
  return outcome;
}

export async function deleteGoalRecord(
  goalId: string,
  nowMs = Date.now(),
): Promise<GoalBoardConfigV1> {
  const scope = captureDataOwnerBroadcastScope();
  const next = await withLocalWriteLock(async () => {
    const file = getStoreFile();
    file.invalidateIfChanged();
    const updated = await file.updateAtomic(
      (state) => {
        const current = normalizeGoalBoardConfig(state.value);
        return {
          version: 1,
          updatedAtMs: nowMs,
          goals: current.goals.filter((g) => g.id !== goalId),
        } satisfies GoalBoardConfigV1;
      },
      { preserveDefaults: true },
    );
    return normalizeGoalBoardConfig(updated);
  });

  if (isDataOwnerBroadcastScopeCurrent(scope)) {
    emitGoalBoardChanged({ ownerId: getSafeOwnerId(), config: next }, scope.ownerStamp);
  }
  return next;
}

export function registerGoalBoardIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('local-db:goal-board:get', (event) => {
    if (!isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event);
    }
    return readGoalBoardSnapshot();
  });

  ipcMain.handle('local-db:goal-board:upsert', async (event, input: GoalUpsertInput) => {
    if (!isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event);
    }
    const { config, goal } = await upsertGoalRecord(input);
    return { ownerId: getSafeOwnerId(), config, goal };
  });

  ipcMain.handle(
    'local-db:goal-board:transition-item',
    async (event, input: { goalId: string } & GoalItemTransitionInput) => {
      if (!isDeviceLinkInvoke()) {
        assertTrustedAppRendererEvent(event);
      }
      const res = await transitionGoalWorkItem(input);
      if (!res.ok) return res;
      return {
        ok: true as const,
        ownerId: getSafeOwnerId(),
        config: res.config,
        goal: res.goal,
        item: res.item,
        newlyUnlockedIds: res.newlyUnlockedIds,
      };
    },
  );

  ipcMain.handle('local-db:goal-board:remove', async (event, goalId: string) => {
    if (!isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event);
    }
    const config = await deleteGoalRecord(goalId);
    return { ownerId: getSafeOwnerId(), config };
  });
}

export function resetGoalBoardStoreForTests(): void {
  storeFile = null;
  storeFilePathCache = null;
  ipcRegistered = false;
  localWriteChain = Promise.resolve();
}
