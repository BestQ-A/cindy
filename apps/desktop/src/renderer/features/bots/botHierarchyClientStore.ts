/**
 * Renderer mirror and mutation entry point for the multi-level buddy hierarchy.
 *
 * Main owns persistent storage and cross-computer sync (`local-db:bots:hierarchy:*`).
 * This store maintains an account-scoped (`dataOwnerGeneration`) in-memory projection,
 * applies optimistic updates for responsive sidebar interactions, reconciles push
 * notifications, and degrades cleanly to in-memory state in test environments
 * where preload IPC bindings are absent.
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import {
  type BotHierarchyConfigV1,
  createEmptyBotHierarchyConfig,
  mergeBotHierarchyConfigs,
  normalizeBotHierarchyConfig,
} from '../../../shared/botHierarchy';

const log = createLogger('BotHierarchyClientStore');

export interface BotHierarchyClientSnapshot {
  ownerId: string | null;
  config: BotHierarchyConfigV1;
  loaded: boolean;
}

interface BotHierarchyIpcResponse {
  ownerId: string | null;
  config: BotHierarchyConfigV1;
}

interface BotHierarchyPreloadApi {
  get: () => Promise<BotHierarchyIpcResponse>;
  write: (body: {
    ownerId?: string | null;
    config: BotHierarchyConfigV1;
    mode?: 'merge' | 'replace';
  }) => Promise<BotHierarchyIpcResponse>;
  sync?: () => Promise<BotHierarchyIpcResponse>;
  onChanged?: (callback: (payload: unknown, ownerStamp?: unknown) => void) => () => void;
}

function createEmptySnapshot(ownerId: string | null, loaded = false): BotHierarchyClientSnapshot {
  return {
    ownerId,
    config: createEmptyBotHierarchyConfig(),
    loaded,
  };
}

let owner = getDataOwnerGeneration();
let generation = 0;
let snapshot: BotHierarchyClientSnapshot = createEmptySnapshot(owner.dataOwnerId, false);
let hydratedGeneration = -1;
let pendingMutationCount = 0;
let hasLocalMutationInGeneration = false;
let writeQueue: Promise<void> = Promise.resolve();
let syncUsers = 0;
let unsubscribePush: (() => void) | null = null;
const listeners = new Set<() => void>();

function hierarchyApi(): BotHierarchyPreloadApi | null {
  if (typeof window === 'undefined') return null;
  const botsApi = (window.electronAPI?.localDb?.bots ?? undefined) as
    | { hierarchy?: BotHierarchyPreloadApi }
    | undefined;
  const api = botsApi?.hierarchy;
  if (!api || typeof api.get !== 'function' || typeof api.write !== 'function') {
    return null;
  }
  return api;
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function detachPushListener(): void {
  unsubscribePush?.();
  unsubscribePush = null;
}

function ensureOwner(): boolean {
  if (isDataOwnerGenerationCurrent(owner)) {
    return false;
  }
  owner = getDataOwnerGeneration();
  generation += 1;
  hydratedGeneration = -1;
  pendingMutationCount = 0;
  hasLocalMutationInGeneration = false;
  writeQueue = Promise.resolve();
  snapshot = createEmptySnapshot(owner.dataOwnerId, false);
  return true;
}

function applyConfig(
  nextRaw: BotHierarchyConfigV1,
  options?: { loaded?: boolean; mergeWithExisting?: boolean },
): void {
  const normalized = normalizeBotHierarchyConfig(nextRaw);
  const resolved = options?.mergeWithExisting
    ? mergeBotHierarchyConfigs(snapshot.config, normalized)
    : normalized;
  const nextLoaded = options?.loaded ?? true;
  if (
    snapshot.loaded === nextLoaded &&
    snapshot.ownerId === owner.dataOwnerId &&
    JSON.stringify(snapshot.config) === JSON.stringify(resolved)
  ) {
    return;
  }
  snapshot = {
    ownerId: owner.dataOwnerId,
    config: resolved,
    loaded: nextLoaded,
  };
  emit();
}

function isValidPushPayload(payload: unknown): payload is { ownerId?: string | null; config: BotHierarchyConfigV1 } {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  if ('ownerId' in record && record.ownerId !== undefined && record.ownerId !== owner.dataOwnerId) {
    return false;
  }
  return Boolean(record.config && typeof record.config === 'object');
}

function attachPushListener(): void {
  if (unsubscribePush) return;
  const api = hierarchyApi();
  if (!api || typeof api.onChanged !== 'function') return;
  unsubscribePush = api.onChanged((payload, ownerStamp) => {
    if (!isDataOwnerPushCurrent(ownerStamp)) return;
    ensureOwner();
    if (!isValidPushPayload(payload)) return;
    // Ignore intermediate pushes while local writes are still flushing; the final write response commits canonical state.
    if (pendingMutationCount > 0) return;
    applyConfig(payload.config, { loaded: true });
  });
}

async function hydrateForCurrentOwner(): Promise<BotHierarchyClientSnapshot> {
  ensureOwner();
  const requestGeneration = generation;
  const requestOwner = owner;
  const api = hierarchyApi();

  if (!api) {
    if (!snapshot.loaded) {
      snapshot = { ...snapshot, ownerId: owner.dataOwnerId, loaded: true };
      emit();
    }
    return snapshot;
  }

  try {
    const response = await api.get();
    if (requestGeneration !== generation || !isDataOwnerGenerationCurrent(requestOwner)) {
      return snapshot;
    }
    if (response.ownerId !== undefined && response.ownerId !== requestOwner.dataOwnerId) {
      return snapshot;
    }
    const shouldMerge = pendingMutationCount > 0 || hasLocalMutationInGeneration;
    applyConfig(response.config, { loaded: true, mergeWithExisting: shouldMerge });
  } catch (err) {
    log.warn('failed to read bot hierarchy from host:', err);
    if (requestGeneration === generation && isDataOwnerGenerationCurrent(requestOwner) && !snapshot.loaded) {
      snapshot = { ...snapshot, ownerId: owner.dataOwnerId, loaded: true };
      emit();
    }
  }
  return snapshot;
}

function ensureSubscribedRuntime(): void {
  const ownerChanged = ensureOwner();
  if (ownerChanged && syncUsers > 0) {
    detachPushListener();
  }
  if (syncUsers > 0) {
    attachPushListener();
    if (hydratedGeneration !== generation) {
      hydratedGeneration = generation;
      void hydrateForCurrentOwner();
    }
  }
}

function subscribe(listener: () => void): () => void {
  ensureOwner();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Synchronously reports whether the host preload IPC bindings for bot hierarchy are mounted. */
export function hasBotHierarchyHostApi(): boolean {
  return hierarchyApi() !== null;
}

/** Returns true when a hierarchy config has never been edited, populated, or tombstoned. */
export function isUntouchedEmptyBotHierarchy(config: BotHierarchyConfigV1): boolean {
  return (
    config.updatedAt === 0 &&
    Object.keys(config.folders).length === 0 &&
    Object.keys(config.assignments).length === 0 &&
    Object.keys(config.deletedFolderIds).length === 0
  );
}

/** Synchronously returns the current owner's cached hierarchy snapshot. */
export function getBotHierarchySnapshot(): BotHierarchyClientSnapshot {
  ensureOwner();
  return snapshot;
}

/** Subscribes a React component to the account-scoped buddy hierarchy store. */
export function useBotHierarchy(): BotHierarchyClientSnapshot {
  const currentSnapshot = useSyncExternalStore(subscribe, getBotHierarchySnapshot, getBotHierarchySnapshot);

  useEffect(() => {
    syncUsers += 1;
    ensureSubscribedRuntime();
    return () => {
      syncUsers = Math.max(0, syncUsers - 1);
      if (syncUsers === 0) {
        detachPushListener();
      }
    };
  }, [currentSnapshot.ownerId]);

  return currentSnapshot;
}

/** Manually refreshes the buddy hierarchy snapshot from the host (optionally triggering cloud sync). */
export async function refreshBotHierarchy(sync = false): Promise<BotHierarchyClientSnapshot> {
  ensureOwner();
  const api = hierarchyApi();
  if (!api) {
    if (!snapshot.loaded) {
      snapshot = { ...snapshot, ownerId: owner.dataOwnerId, loaded: true };
      emit();
    }
    return snapshot;
  }

  const requestGeneration = generation;
  const requestOwner = owner;
  try {
    const response = sync && typeof api.sync === 'function' ? await api.sync() : await api.get();
    if (requestGeneration !== generation || !isDataOwnerGenerationCurrent(requestOwner)) {
      return snapshot;
    }
    applyConfig(response.config, {
      loaded: true,
      mergeWithExisting: pendingMutationCount > 0,
    });
  } catch (err) {
    log.warn('failed to refresh bot hierarchy:', err);
  }
  return snapshot;
}

/**
 * Applies a hierarchy mutation optimistically and persists it to main when IPC is available.
 * Consecutive writes for the same account owner are serialized to preserve causal ordering.
 */
export async function mutateBotHierarchy(
  updater: (current: BotHierarchyConfigV1) => BotHierarchyConfigV1,
  options?: { mode?: 'merge' | 'replace' },
): Promise<BotHierarchyConfigV1> {
  ensureOwner();
  const requestGeneration = generation;
  const requestOwner = owner;
  const prevSerialized = JSON.stringify(snapshot.config);
  const nextConfig = normalizeBotHierarchyConfig(updater(snapshot.config));
  const nextSerialized = JSON.stringify(nextConfig);

  if (prevSerialized === nextSerialized && snapshot.loaded) {
    return snapshot.config;
  }

  hasLocalMutationInGeneration = true;
  applyConfig(nextConfig, { loaded: true });

  const api = hierarchyApi();
  if (!api) {
    return nextConfig;
  }

  const mode = options?.mode ?? 'merge';
  pendingMutationCount += 1;

  const task = writeQueue.then(async () => {
    if (requestGeneration !== generation || !isDataOwnerGenerationCurrent(requestOwner)) {
      return;
    }
    try {
      const response = await api.write({
        ownerId: requestOwner.dataOwnerId,
        config: nextConfig,
        mode,
      });
      if (requestGeneration !== generation || !isDataOwnerGenerationCurrent(requestOwner)) {
        return;
      }
      if (pendingMutationCount <= 1 && response?.config) {
        applyConfig(response.config, { loaded: true });
      }
    } catch (err) {
      log.warn('failed to write bot hierarchy to host:', err);
      if (requestGeneration === generation && isDataOwnerGenerationCurrent(requestOwner) && pendingMutationCount <= 1) {
        try {
          const fallback = await api.get();
          if (requestGeneration === generation && isDataOwnerGenerationCurrent(requestOwner)) {
            applyConfig(fallback.config, { loaded: true });
          }
        } catch {
          // Retain last known snapshot when host read is also unavailable.
        }
      }
    } finally {
      if (requestGeneration === generation) {
        pendingMutationCount = Math.max(0, pendingMutationCount - 1);
      }
    }
  });

  writeQueue = task.catch(() => undefined);
  await task;
  return requestGeneration === generation && isDataOwnerGenerationCurrent(requestOwner)
    ? snapshot.config
    : nextConfig;
}

/** Generates a non-colliding sibling folder name from a localized default base name. */
export function resolveUniqueBotFolderName(
  config: BotHierarchyConfigV1,
  baseName: string,
  parentId: string | null = null,
): string {
  const trimmed = baseName.trim() || 'Untitled Folder';
  const normalizedParent = parentId ?? null;
  const siblingNames = new Set(
    Object.values(config.folders)
      .filter((folder) => (folder.parentId ?? null) === normalizedParent)
      .map((folder) => folder.name.trim().toLowerCase()),
  );
  if (!siblingNames.has(trimmed.toLowerCase())) {
    return trimmed;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${trimmed} ${index}`;
    if (!siblingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${trimmed} ${Date.now().toString(36)}`;
}

/** Resets module-level store state between Vitest cases. */
export function resetBotHierarchyStoreForTests(): void {
  detachPushListener();
  listeners.clear();
  owner = getDataOwnerGeneration();
  generation += 1;
  hydratedGeneration = -1;
  pendingMutationCount = 0;
  hasLocalMutationInGeneration = false;
  writeQueue = Promise.resolve();
  syncUsers = 0;
  snapshot = createEmptySnapshot(owner.dataOwnerId, false);
}
